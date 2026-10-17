// Background prompt the next Ask will actually send. Ollama's KV cache is the
// rendered prefix, so this has to be the real system text and tool definitions,
// not an empty load. The user turn stops at the stable prefix — the question
// and the sources are not known yet.

import { ASK_SEARCH_TOOLS } from "./agent-search-tools.js";
import { AGENTIC_WARM_USER_PREFIX, ASK_AGENT_SYSTEM } from "./ask-agent.js";
import { CLASSIC_USER_PREFIX, GROUNDING_SYSTEM } from "./ask.js";
import type { ChatWarmKind, ChatWarmRequest } from "./model-provider.js";

export function chatWarmRequest(kind: ChatWarmKind): ChatWarmRequest {
  if (kind === "agentic") {
    return {
      kind,
      messages: [
        { role: "system", content: ASK_AGENT_SYSTEM },
        { role: "user", content: AGENTIC_WARM_USER_PREFIX },
      ],
      tools: ASK_SEARCH_TOOLS,
    };
  }
  return {
    kind,
    messages: [
      { role: "system", content: GROUNDING_SYSTEM },
      { role: "user", content: CLASSIC_USER_PREFIX },
    ],
  };
}
