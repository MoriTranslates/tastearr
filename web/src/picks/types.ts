import type { Pick, Status } from "../api";
import type { useToast } from "../components/ui";

export type CardProps = {
  patch: (id: number, c: Partial<Pick>) => void;
  toast: ReturnType<typeof useToast>;
  status: Status;
  onAdd: (p: Pick, mode?: "add" | "monitor" | "pick-season") => void;
};

export type Mode = "add" | "monitor" | "pick-season";
