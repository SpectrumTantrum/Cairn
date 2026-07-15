import { useState } from "react";
import { MoreHorizontal, Plus } from "lucide-react";
import type { EscalateTarget, ProviderMeta, SearchHit, StudioTemplateMeta, ThreadMeta } from "../../../shared/types.js";
import { ChatTab } from "./ChatTab";
import type { ChatTurn } from "./ChatTab";
import type { AgentMode } from "./Composer";
import { SourcesTab } from "./SourcesTab";
import { StudioTab } from "./StudioTab";
import { ThreadHistory } from "./ThreadHistory";
import type { RightTab } from "../../settings";

export type { RightTab };

interface RightRailProps {
  activeTab: RightTab;
  onTabChange(tab: RightTab): void;
  onNewThread(): void;
  // thread history (issue #25)
  threads: ThreadMeta[];
  activeThreadId: string | null;
  onOpenHistory(): void;
  onLoadThread(id: string): void;
  onDeleteThread(id: string): void;
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
  providers: ProviderMeta[];
  escalateTarget: EscalateTarget | null;
  onInputChange(value: string): void;
  onSelectMode(mode: AgentMode): void;
  onSelectModel(model: string): void;
  onSelectEscalation(target: EscalateTarget | null): void;
  onOpenSettings(): void;
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
  // studio (issue #26)
  studioTemplates: StudioTemplateMeta[];
  onStudioGenerate(templateId: string, topic: string): void;
}

const TABS: { id: RightTab; label: string }[] = [
  { id: "chat", label: "Chat" },
  { id: "sources", label: "Sources" },
  { id: "studio", label: "Studio" },
];

export function RightRail(props: RightRailProps) {
  const { activeTab, onTabChange, onNewThread, thread, busy } = props;
  const [historyOpen, setHistoryOpen] = useState(false);

  function toggleHistory(): void {
    setHistoryOpen((open) => {
      const next = !open;
      if (next) props.onOpenHistory();
      return next;
    });
  }

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
        <div className="thread-history-anchor">
          <button
            type="button"
            className={`icon-btn${historyOpen ? " active" : ""}`}
            title="Thread history"
            aria-haspopup="menu"
            aria-expanded={historyOpen}
            onClick={toggleHistory}
          >
            <MoreHorizontal size={16} />
          </button>
          {historyOpen ? (
            <ThreadHistory
              threads={props.threads}
              activeThreadId={props.activeThreadId}
              onLoad={(id) => {
                setHistoryOpen(false);
                props.onLoadThread(id);
              }}
              onDelete={props.onDeleteThread}
              onNewThread={() => {
                setHistoryOpen(false);
                onNewThread();
              }}
              onClose={() => setHistoryOpen(false)}
            />
          ) : null}
        </div>
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
            providers={props.providers}
            escalateTarget={props.escalateTarget}
            onInputChange={props.onInputChange}
            onSelectMode={props.onSelectMode}
            onSelectModel={props.onSelectModel}
            onSelectEscalation={props.onSelectEscalation}
            onOpenSettings={props.onOpenSettings}
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
          <StudioTab
            templates={props.studioTemplates}
            busy={props.busy}
            disabled={props.composerDisabled}
            disabledReason={props.composerReason}
            scopeCount={props.scopeCount}
            onGenerate={props.onStudioGenerate}
          />
        )}
      </div>
    </>
  );
}
