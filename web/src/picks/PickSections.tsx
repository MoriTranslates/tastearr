import type { Pick, Section } from "../api";
import { PickCard } from "./PickCard";
import { SECTIONS, type SortKey } from "./helpers";
import type { CardProps } from "./types";

interface Props extends CardProps {
  visible: Pick[];
  top: Pick | null;
  sort: SortKey;
  collapsed: Section[];
  setCollapsed: (v: Section[]) => void;
  lowOpen: Section[];
  setLowOpen: (v: Section[]) => void;
}

/** The grid view: one collapsible group per section. */
export function PickSections({ visible, top, sort, collapsed, setCollapsed, lowOpen, setLowOpen, patch, toast, status, onAdd }: Props) {
  return (
    <>
      {SECTIONS.map((sec) => {
        const all = visible.filter((p) => p.section === sec.id && p.id !== top?.id);
        if (!all.length) return null;
        const open = !collapsed.includes(sec.id);
        // Low matches (mostly kids minis and promos in Shorts) wait behind "show more" unless sorted otherwise.
        const cut = sec.id === "shorts" ? 20 : 15;
        const early = (p: Pick) => p.lowConfidence && p.status === "NOT_YET_RELEASED";
        const low =
          sort === "match" && !lowOpen.includes(sec.id)
            ? all.filter((p) => p.match < cut && !early(p) && !p.inLibrary && !p.myStatus && !p.following)
            : [];
        const items = all.filter((p) => !low.includes(p));
        if (sec.id === "continuing" && sort === "match")
          items.sort(
            (a, b) =>
              Number(!!b.continues?.kept || !!b.myStatus || b.inLibrary) - Number(!!a.continues?.kept || !!a.myStatus || a.inLibrary),
          );
        return (
          <div key={sec.id} className="section">
            <h2 className="section-head">
              <button
                aria-expanded={open}
                onClick={() => setCollapsed(open ? [...collapsed, sec.id] : collapsed.filter((x) => x !== sec.id))}
              >
                <span className="caret" aria-hidden="true">
                  {open ? "▾" : "▸"}
                </span>
                {sec.label}
                <span className="count">{items.length}</span>
              </button>
              <span className="muted small hint">{sec.hint}</span>
            </h2>
            {open && (
              <>
                <div className="grid">
                  {items.map((p) => (
                    <PickCard key={p.id} p={p} patch={patch} toast={toast} status={status} onAdd={onAdd} />
                  ))}
                </div>
                {low.length > 0 && (
                  <button className="ghost small more-low" onClick={() => setLowOpen([...lowOpen, sec.id])}>
                    Show {low.length} more that don't look like your thing
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
