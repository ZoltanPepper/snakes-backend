import { request } from "undici";

type WebhookPayload = {
  content?: string;
  embeds?: any[];
};

export async function postDiscordWebhook(webhookUrl: string | undefined, payload: WebhookPayload) {
  const url = (webhookUrl ?? "").trim();

  console.log("[discord] post called. urlLen=", url.length);

  if (!url) {
    console.log("[discord] No webhook URL set. Skipping.");
    return;
  }

  try {
    const res = await request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });

    const text = await res.body.text();

    console.log("[discord] status=", res.statusCode, "body=", text ? text.slice(0, 200) : "<empty>");
  } catch (err) {
    console.error("[discord] request error:", err);
  }
}
