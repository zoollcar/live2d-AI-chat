import type { SceneSnapshot } from "@/model/live2d/catalog";

/**
 * Prefix the newest user message with ephemeral, application-owned context.
 * The caller must keep the original user message in React history so this
 * changing block is never rendered or replayed on a later turn.
 */
export function prefixAgentStatus(
  userMessage: string,
  snapshot: SceneSnapshot,
  now = new Date(),
): string {
  return `<agent_status>
current_time: ${formatLocalTime(now)}
character_state: ${snapshot.state}
decorations: ${JSON.stringify(snapshot.decorations)}
active_action: ${snapshot.action ?? "none"}
stage_layout: ${snapshot.layout}
</agent_status>

<user_message>
${userMessage}
</user_message>`;
}

function formatLocalTime(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = Math.floor(Math.abs(offsetMinutes) / 60);
  const offsetRemainder = Math.abs(offsetMinutes) % 60;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} GMT${sign}${pad(offsetHours)}:${pad(offsetRemainder)} (${timezone})`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
