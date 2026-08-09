const decoder = new TextDecoder();

export async function* parseSse(body) {
  if (!body) return;
  let buffer = "";
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    buffer = buffer.replaceAll("\r\n", "\n");
    while (true) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseBlock(block);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  const finalEvent = parseSseBlock(buffer.trim());
  if (finalEvent) yield finalEvent;
}

export function parseSseBlock(block) {
  if (!block) return null;
  let event = "message";
  let id;
  const data = [];
  for (const rawLine of block.split("\n")) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const colon = rawLine.indexOf(":");
    const field = colon < 0 ? rawLine : rawLine.slice(0, colon);
    let value = colon < 0 ? "" : rawLine.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  return { event, data: data.join("\n"), id };
}

export function encodeSse(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}
