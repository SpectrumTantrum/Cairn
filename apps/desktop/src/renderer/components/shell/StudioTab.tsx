import {
  BookOpen,
  ChevronRight,
  FileText,
  HelpCircle,
  Layers,
  ListChecks,
  Network,
  Clock,
} from "lucide-react";
import type { ComponentType } from "react";

interface StudioCard {
  title: string;
  Icon: ComponentType<{ size?: number }>;
  /** What still has to land before this generator can ship. */
  needs: string;
}

/** Cairn's 7 grounded-output generators (v1-scope). All disabled this pass. */
const CARDS: StudioCard[] = [
  { title: "Study Guide", Icon: BookOpen, needs: "grounded generation" },
  { title: "Briefing", Icon: FileText, needs: "grounded generation" },
  { title: "FAQ", Icon: HelpCircle, needs: "grounded generation" },
  { title: "Timeline", Icon: Clock, needs: "grounded generation" },
  { title: "Mind Map", Icon: Network, needs: "interactive graph output" },
  { title: "Flashcards", Icon: Layers, needs: "grounded generation" },
  { title: "Quiz", Icon: ListChecks, needs: "interactive quiz output" },
];

export function StudioTab() {
  return (
    <div className="studio-body">
      <div className="studio-grid">
        {CARDS.map(({ title, Icon, needs }) => (
          <div
            className="studio-card"
            key={title}
            aria-disabled="true"
            title={`Coming in v1 — needs ${needs}`}
          >
            <div className="studio-card-top">
              <Icon size={18} />
              <ChevronRight size={16} />
            </div>
            <span className="studio-card-title">{title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
