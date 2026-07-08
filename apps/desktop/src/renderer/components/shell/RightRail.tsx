import { MoreHorizontal, Plus } from "lucide-react";
import type { SearchHit } from "../../../shared/types.js";
import { ChatTab } from "./ChatTab";
import type { ChatTurn } from "./ChatTab";
import type { AgentMode } from "./Composer";
import { SourcesTab } from "./SourcesTab";
import { StudioTab } from "./StudioTab";

export type RightTab = "chat" | "sources" | "studio";

interface RightRailProps {
  activeTab: RightTab;
  onTabChange(tab: RightTab): void;
  onNewThread(): void;
  // chat
  thread: ChatTurn[];
  busy: boolean;
  input: string;
  mode: AgentMode;
  composerDisabled: boolean;
  composerReason: string | null;
  ollamaUp: boolean;
  models: string[];
  selectedModel: string | null;
  scopeCount: number;
  onInputChange(value: string): void;
  onSelectMode(mode: AgentMode): void;
  onSelectModel(model: string): void;
  onSubmit(): void;
  onClearScope(): void;
  onCite(source: SearchHit): void;
  onAgentApply(runId: string, proposalId: string): void;
  onAgentReject(runId: string, proposalId: string): void;
  onAgentRevert(runId: string): void;
  // sources
  sources: SearchHit[];
  excludedSources: Set<string>;
  onToggleSource(file: string): void;
}

const TABS: { id: RightTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "sources", label: "Sources" },
  { id: "studio", label: "Studio" },
];

export function RightRail(props: RightRailProps) {
  const { activeTab, onTabChange, onNewThread, thread, busy } = props;
  return (
    <>
      <div className="rail-tabstrip">
        {TABS.map((tab) => (
          <button
            type="button"
            key={tab.id}
            className={`rail-tab${activeTab === tab.id ? " active" : ""}`}
            onClick={() => onTabChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn"
          title={busy ? "Stop and start a new thread" : "New thread"}
          onClick={onNewThread}
          disabled={thread.length === 0}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="icon-btn"
          disabled
          title="Coming in v1 — thread history & options"
        >
          <MoreHorizontal size={16} />
        </button>
      </div>

      <div className="rail-body">
        {activeTab === "chat" ? (
          <ChatTab
            thread={props.thread}
            busy={props.busy}
            input={props.input}
            mode={props.mode}
            composerDisabled={props.composerDisabled}
            composerReason={props.composerReason}
            ollamaUp={props.ollamaUp}
            models={props.models}
            selectedModel={props.selectedModel}
            scopeCount={props.scopeCount}
            onInputChange={props.onInputChange}
            onSelectMode={props.onSelectMode}
            onSelectModel={props.onSelectModel}
            onSubmit={props.onSubmit}
            onClearScope={props.onClearScope}
            onCite={props.onCite}
            onAgentApply={props.onAgentApply}
            onAgentReject={props.onAgentReject}
            onAgentRevert={props.onAgentRevert}
          />
        ) : activeTab === "sources" ? (
          <SourcesTab
            sources={props.sources}
            excluded={props.excludedSources}
            onToggle={props.onToggleSource}
            onOpen={props.onCite}
          />
        ) : (
          <StudioTab />
        )}
      </div>
    </>
  );
}
