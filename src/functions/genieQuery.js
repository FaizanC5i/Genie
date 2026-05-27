const { app } = require('@azure/functions');
const { randomUUID } = require('node:crypto');

const STILL_WORKING = new Set([
    'IN_PROGRESS',
    'ASKING_AI',
    'EXECUTING_QUERY',
    'FILTERING_CONTEXT',
    'PENDING_WAREHOUSE'
]);

function getConfig() {
    const required = ['DATABRICKS_INSTANCE', 'GENIE_SPACE_ID', 'DATABRICKS_TOKEN'];
    const missing = required.filter((key) => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    return {
        databricksInstance: process.env.DATABRICKS_INSTANCE.replace(/\/$/, ''),
        genieSpaceId: process.env.GENIE_SPACE_ID,
        databricksToken: process.env.DATABRICKS_TOKEN,
        allowedOrigin: process.env.ALLOWED_ORIGIN || '*',
        pollIntervalMs: Number.parseInt(process.env.GENIE_POLL_INTERVAL_MS || '5000', 10),
        maxPollAttempts: Number.parseInt(process.env.GENIE_MAX_POLL_ATTEMPTS || '60', 10),
        queryResultDelayMs: Number.parseInt(process.env.GENIE_QUERY_RESULT_DELAY_MS || '2000', 10),
        fetchTimeoutMs: Number.parseInt(process.env.GENIE_FETCH_TIMEOUT_MS || '30000', 10),
        includeAttachmentDebug: (process.env.INCLUDE_ATTACHMENT_DEBUG || 'false').toLowerCase() === 'true',
        fetchAttachmentImages: (process.env.GENIE_FETCH_ATTACHMENT_IMAGES || 'true').toLowerCase() === 'true',
        imageMaxBytes: Number.parseInt(process.env.GENIE_IMAGE_MAX_BYTES || '2000000', 10)
    };
}

function createCorsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-functions-key, x-correlation-id'
    };
}

function jsonResponse(status, body, corsHeaders) {
    return {
        status,
        headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
        },
        jsonBody: body
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbsoluteHttpUrl(value) {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function buildAbsoluteUrl(baseUrl, maybeRelativeUrl) {
    if (!maybeRelativeUrl) {
        return null;
    }
    if (isAbsoluteHttpUrl(maybeRelativeUrl)) {
        return maybeRelativeUrl;
    }
    try {
        return new URL(maybeRelativeUrl, `${baseUrl}/`).toString();
    } catch {
        return null;
    }
}

function extractMarkdownImageUrl(text) {
    if (typeof text !== 'string') {
        return null;
    }
    const match = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i);
    return match?.[1] || null;
}

function extractImageInfo(attachment, baseInstanceUrl) {
    const image = attachment?.image || attachment?.chart || attachment?.visualization || attachment?.asset || null;
    const textContent = attachment?.text?.content || attachment?.text || null;
    const rawUrl =
        image?.url ||
        image?.signed_url ||
        image?.download_url ||
        attachment?.image_url ||
        attachment?.download_url ||
        extractMarkdownImageUrl(textContent) ||
        attachment?.url ||
        null;

    const inlineDataUrl = image?.data_url || attachment?.data_url || null;

    const resolvedUrl = buildAbsoluteUrl(baseInstanceUrl, rawUrl);
    const mimeType =
        image?.mime_type ||
        image?.content_type ||
        attachment?.mime_type ||
        attachment?.content_type ||
        null;

    return {
        url: resolvedUrl,
        data_url: inlineDataUrl,
        mime_type: mimeType,
        caption: image?.caption || attachment?.caption || null,
        width: image?.width || null,
        height: image?.height || null
    };
}

async function parseQuestion(request) {
    try {
        const body = await request.json();
        return typeof body?.question === 'string' ? body.question.trim() : '';
    } catch {
        return request.query.get('question')?.trim() || '';
    }
}

async function parseErrorResponse(response) {
    try {
        const data = await response.json();
        return JSON.stringify(data);
    } catch {
        return await response.text();
    }
}

async function databricksFetch(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, {
            ...options,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeout);
    }
}

function summarizeAttachment(attachment, baseInstanceUrl) {
    const imageInfo = extractImageInfo(attachment, baseInstanceUrl);

    const query = attachment?.query || null;

    return {
        attachment_id: attachment?.attachment_id || null,
        type: attachment?.attachment_type || attachment?.type || (query ? 'query' : (imageInfo.url || imageInfo.data_url) ? 'visual' : 'text'),
        title: attachment?.title || attachment?.name || null,
        text: attachment?.text?.content || attachment?.text || null,
        sql: query?.query || null,
        statement_id: query?.statement_id || null,
        visualization: (imageInfo.url || imageInfo.data_url) ? imageInfo : null,
        image: (imageInfo.url || imageInfo.data_url) ? imageInfo : null
    };
}

async function fetchImageAsDataUrl(imageUrl, mimeType, headers, timeoutMs, imageMaxBytes) {
    const tryFetch = async (requestHeaders) => {
        const response = await databricksFetch(imageUrl, { headers: requestHeaders }, timeoutMs);
        if (!response.ok) {
            throw new Error(`Image fetch failed with status ${response.status}`);
        }

        const contentLength = Number.parseInt(response.headers.get('content-length') || '0', 10);
        if (contentLength > imageMaxBytes) {
            throw new Error(`Image too large (${contentLength} bytes). Max is ${imageMaxBytes}.`);
        }

        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > imageMaxBytes) {
            throw new Error(`Image too large (${arrayBuffer.byteLength} bytes). Max is ${imageMaxBytes}.`);
        }

        const resolvedMimeType = mimeType || response.headers.get('content-type') || 'image/png';
        const base64 = Buffer.from(arrayBuffer).toString('base64');
        return {
            data_url: `data:${resolvedMimeType};base64,${base64}`,
            mime_type: resolvedMimeType,
            byte_length: arrayBuffer.byteLength
        };
    };

    try {
        return await tryFetch(headers);
    } catch {
        return await tryFetch(undefined);
    }
}

async function fetchAttachmentResult({ attachment, pollUrl, headers, delayMs, timeoutMs, context, fetchImageData, imageMaxBytes, baseInstanceUrl }) {
    const result = summarizeAttachment(attachment, baseInstanceUrl);

    if (fetchImageData && result.image?.url) {
        try {
            const imageData = await fetchImageAsDataUrl(
                result.image.url,
                result.image.mime_type,
                headers,
                timeoutMs,
                imageMaxBytes
            );
            result.image = {
                ...result.image,
                ...imageData
            };
        } catch (error) {
            context.warn(`Image fetch failed for attachment ${result.attachment_id || 'unknown'}: ${error.message}`);
            result.image_error = error.message;
        }
    }

    if (!result.attachment_id || !result.statement_id) {
        return result;
    }

    if (delayMs > 0) {
        await sleep(delayMs);
    }

    const dataUrl = `${pollUrl}/query-result/${result.attachment_id}`;
    const response = await databricksFetch(dataUrl, { headers }, timeoutMs);

    if (!response.ok) {
        const details = await parseErrorResponse(response);
        context.warn(`Query result fetch failed for attachment ${result.attachment_id}: ${response.status} ${details}`);
        return {
            ...result,
            data_error: {
                status: response.status,
                details
            }
        };
    }

    return {
        ...result,
        data: await response.json()
    };
}

app.http('genieQuery', {
    methods: ['GET', 'POST', 'OPTIONS'],
    authLevel: 'anonymous',
    route: 'genie-query',
    handler: async (request, context) => {
        const startedAt = Date.now();
        let config;

        try {
            config = getConfig();
        } catch (error) {
            context.error(error.message);
            return jsonResponse(500, { error: error.message }, createCorsHeaders('*'));
        }

        const corsHeaders = createCorsHeaders(config.allowedOrigin);

        if (request.method === 'OPTIONS') {
            return {
                status: 204,
                headers: corsHeaders
            };
        }

        const requestId = request.headers.get('x-correlation-id') || randomUUID();
        const question = await parseQuestion(request);

        if (!question) {
            return jsonResponse(400, { error: "Missing 'question' field." }, corsHeaders);
        }

        const baseUrl = `${config.databricksInstance}/api/2.0/genie/spaces/${config.genieSpaceId}`;
        const headers = {
            Authorization: `Bearer ${config.databricksToken}`,
            'Content-Type': 'application/json'
        };

        context.log(`requestId=${requestId} Starting Genie query`);

        let startData;
        try {
            const response = await databricksFetch(
                `${baseUrl}/start-conversation`,
                {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ content: question })
                },
                config.fetchTimeoutMs
            );

            if (!response.ok) {
                const details = await parseErrorResponse(response);
                context.error(`requestId=${requestId} Failed to start conversation: ${response.status} ${details}`);
                return jsonResponse(
                    response.status,
                    {
                        error: 'Failed to start Genie conversation.',
                        details,
                        request_id: requestId
                    },
                    corsHeaders
                );
            }

            startData = await response.json();
        } catch (error) {
            context.error(`requestId=${requestId} Network error starting conversation: ${error.message}`);
            return jsonResponse(
                502,
                {
                    error: 'Network error calling Databricks.',
                    details: error.message,
                    request_id: requestId
                },
                corsHeaders
            );
        }

        const conversationId = startData?.conversation?.id;
        const messageId = startData?.message?.id;

        if (!conversationId || !messageId) {
            context.error(`requestId=${requestId} Missing IDs in start conversation response`);
            return jsonResponse(
                502,
                {
                    error: 'Genie start-conversation response was missing identifiers.',
                    request_id: requestId,
                    start_response: config.includeAttachmentDebug ? startData : undefined
                },
                corsHeaders
            );
        }

        const pollUrl = `${baseUrl}/conversations/${conversationId}/messages/${messageId}`;
        let pollData = null;
        let status = 'IN_PROGRESS';

        for (let attempt = 1; attempt <= config.maxPollAttempts; attempt += 1) {
            await sleep(config.pollIntervalMs);
//meow
            let pollResponse;
            try {
                pollResponse = await databricksFetch(pollUrl, { headers }, config.fetchTimeoutMs);
            } catch (error) {
                context.warn(`requestId=${requestId} Poll attempt ${attempt} failed: ${error.message}`);
                continue;
            }

            if (!pollResponse.ok) {
                const details = await parseErrorResponse(pollResponse);
                context.warn(`requestId=${requestId} Poll attempt ${attempt} returned ${pollResponse.status}: ${details}`);
                continue;
            }

            pollData = await pollResponse.json();
            status = pollData?.status || 'FAILED';
            context.log(`requestId=${requestId} Poll attempt ${attempt}/${config.maxPollAttempts}: ${status}`);

            if (!STILL_WORKING.has(status)) {
                break;
            }
        }

        if (status !== 'COMPLETED' || !pollData) {
            return jsonResponse(
                504,
                {
                    error: `Genie query ended with status: ${status}`,
                    request_id: requestId,
                    conversation_id: conversationId,
                    message_id: messageId,
                    debug: config.includeAttachmentDebug ? { pollData } : undefined
                },
                corsHeaders
            );
        }

        const attachments = Array.isArray(pollData.attachments) ? pollData.attachments : [];
        const results = await Promise.all(
            attachments.map((attachment) =>
                fetchAttachmentResult({
                    attachment,
                    pollUrl,
                    headers,
                    delayMs: config.queryResultDelayMs,
                    timeoutMs: config.fetchTimeoutMs,
                    context,
                    fetchImageData: config.fetchAttachmentImages,
                    imageMaxBytes: config.imageMaxBytes,
                    baseInstanceUrl: config.databricksInstance
                })
            )
        );

        const responseBody = {
            request_id: requestId,
            conversation_id: conversationId,
            message_id: messageId,
            status,
            question,
            results,
            metadata: {
                attachment_count: attachments.length,
                duration_ms: Date.now() - startedAt
            }
        };

        if (config.includeAttachmentDebug) {
            responseBody.debug = {
                raw_attachments: attachments,
                final_message: pollData
            };
        }

        return jsonResponse(200, responseBody, corsHeaders);
    }
});
