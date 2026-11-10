import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";

export interface PlaceholderPageProps {
  title: string;
  purpose: string;
  icon: LucideIcon;
  emptyTitle: string;
  emptyText: string;
  children?: ReactNode;
}

/** Shared body of the screens that arrive in a later milestone. */
export function PlaceholderPage({ title, purpose, icon, emptyTitle, emptyText, children }: PlaceholderPageProps) {
  return (
    <>
      <PageHeader title={title} description={purpose} />
      {children}
      <EmptyState icon={icon} title={emptyTitle}>
        {emptyText}
      </EmptyState>
    </>
  );
}
