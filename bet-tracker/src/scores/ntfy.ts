import type { AlertKind } from './alerts.js';

/** Where score alerts are pushed. */
export interface Notifier {
  readonly configured: boolean;
  send(n: {
    kind: AlertKind;
    title: string;
    body: string;
    click?: string;
  }): Promise<void>;
}

/** Injected for tests; production uses fetch. */
export type PostJson = (
  url: string,
  body: unknown,
  headers: Record<string, string>
) => Promise<{ ok: boolean; status: number }>;

const postJson: PostJson = async (url, body, headers) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { ok: res.ok, status: res.status };
};

const PRIORITY: Record<AlertKind, number> = {
  start: 2,
  lead: 3,
  close: 4,
  final: 3,
};

/**
 * ntfy (https://ntfy.sh or self-hosted). Published as JSON to the server
 * root so titles may hold emoji/non-ASCII. `topicUrl` is the full topic URL,
 * e.g. https://ntfy.sh/<topic>; it is never logged (the topic is the secret).
 */
export class NtfyNotifier implements Notifier {
  private readonly server: string;
  private readonly topic: string;

  constructor(
    topicUrl: string,
    private readonly token = '',
    private readonly post: PostJson = postJson
  ) {
    const u = topicUrl ? new URL(topicUrl) : null;
    const parts = u ? u.pathname.split('/').filter(Boolean) : [];
    this.topic = parts.pop() ?? '';
    this.server = u ? `${u.origin}/${parts.map((p) => `${p}/`).join('')}` : '';
  }

  get configured() {
    return !!this.topic;
  }

  async send(n: {
    kind: AlertKind;
    title: string;
    body: string;
    click?: string;
  }) {
    if (!this.configured) throw new Error('ntfy is not configured');
    const res = await this.post(
      this.server,
      {
        topic: this.topic,
        title: n.title,
        message: n.body,
        priority: PRIORITY[n.kind],
        ...(n.click ? { click: n.click } : {}),
      },
      this.token ? { Authorization: `Bearer ${this.token}` } : {}
    );
    if (!res.ok) throw new Error(`ntfy -> ${res.status}`);
  }
}
