import type { ReactNode } from "react";
import { useDocumentTitle } from "../../lib/useDocumentTitle";

export interface PageHeaderProps {
  title: string;
  /** One-line purpose. */
  description?: ReactNode;
  actions?: ReactNode;
}

/** Page title block (also sets the browser tab title). */
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  useDocumentTitle(title);
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
