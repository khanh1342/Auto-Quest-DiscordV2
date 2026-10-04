import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const OPENAI_URL = 'https://api.openai.com/v1/responses';
const HOST = process.env.AUTOBUILD_HOST || '0.0.0.0';
const PORT = Number.parseInt(process.env.AUTOBUILD_PORT || '8787', 10);
const MODEL = process.env.AUTOBUILD_OPENAI_MODEL || 'gpt-5';
const MAX_BODY = 64 * 1024;
const MAX_PROMPT = 12000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 20;

const requests = new Map<string, number[]>();

function hasOpenAiKey(): boolean {
	return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
	const body = JSON.stringify(data);
	res.statusCode = status;
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	res.setHeader('Cache-Control', 'no-store');
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.end(body);
}

function isAllowed(ip: string): boolean {
	const now = Date.now();
	const window = requests.get(ip) ?? [];
	while (window.length > 0 && now - window[0] > RATE_WINDOW_MS) {
		window.shift();
	}
	if (window.length >= RATE_LIMIT) {
		requests.set(ip, window);
		return false;
	}
	window.push(now);
	requests.set(ip, window);
	return true;
}

async function readBody(req: IncomingMessage): Promise<string> {
	return await new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				req.destroy();
				reject(new Error('body too large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

function upstreamBody(prompt: string): object {
	return {
		model: MODEL,
		store: false,
		max_output_tokens: 160,
		text: {
			format: {
				type: 'json_schema',
				name: 'autobuild_recovery_decision',
				strict: true,
				schema: {
					type: 'object',
					additionalProperties: false,
					properties: {
						directive: {
							type: 'string',
							enum: [
								'DIRECT',
								'AVOID_LEFT',
								'AVOID_RIGHT',
								'SUPPORT',
								'AIM_RECOVERY',
							],
						},
						confidence: {
							type: 'number',
							minimum: 0,
							maximum: 1,
						},
						reason: { type: 'string' },
					},
					required: ['directive', 'confidence', 'reason'],
				},
			},
		},
		instructions:
			'You are the high-level planning brain for a Minecraft building agent. ' +
			'Output only JSON. Never control keyboard, mouse, camera, packets, inventory, or commands.',
		input: prompt,
	};
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url || '/', 'http://127.0.0.1');
	const ip = req.socket.remoteAddress || 'unknown';

	if (req.method === 'OPTIONS') {
		res.statusCode = 204;
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AutoBuild-Client');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.end();
		return;
	}

	if (url.pathname === '/autobuild/status' && req.method === 'GET') {
		sendJson(res, 200, {
			ok: true,
			ai_enabled: hasOpenAiKey(),
			model: MODEL,
		});
		return;
	}

	if (url.pathname === '/autobuild/decision' && req.method === 'POST') {
		if (!isAllowed(ip)) {
			sendJson(res, 429, { error: { type: 'rate_limit' } });
			return;
		}

		if (!hasOpenAiKey()) {
			sendJson(res, 503, {
				error: {
					type: 'ai_not_configured',
					message: 'OPENAI_API_KEY is missing from the bot environment',
				},
			});
			return;
		}

		let raw: string;
		try {
			raw = await readBody(req);
		} catch {
			sendJson(res, 413, { error: { type: 'body_too_large' } });
			return;
		}

		try {
			const incoming = JSON.parse(raw) as { prompt?: unknown };
			const prompt = String(incoming.prompt ?? '').trim();
			if (!prompt || prompt.length > MAX_PROMPT) {
				sendJson(res, 400, { error: { type: 'invalid_prompt' } });
				return;
			}

			const upstream = await fetch(OPENAI_URL, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify(upstreamBody(prompt)),
			});

			const text = await upstream.text();
			res.statusCode = upstream.status;
			res.setHeader('Content-Type', 'application/json; charset=utf-8');
			res.setHeader('Cache-Control', 'no-store');
			res.end(text);
		} catch {
			sendJson(res, 502, { error: { type: 'upstream_error' } });
		}
		return;
	}

	sendJson(res, 404, { error: { type: 'not_found' } });
}

export function startAutoBuildAiService(): void {
	if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
		console.error('[AutoBuild AI] Invalid AUTOBUILD_PORT.');
		return;
	}

	const server = createServer((req, res) => {
		void handle(req, res);
	});

	server.on('error', (error) => {
		console.error('[AutoBuild AI] HTTP server error:', error.message);
	});

	server.listen(PORT, HOST, () => {
		console.log(
			`[AutoBuild AI] listening on http://${HOST}:${PORT} | OpenAI key: ${hasOpenAiKey() ? 'available' : 'missing'}`,
		);
	});
}
