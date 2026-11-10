import { SearchX } from "lucide-react";
import { ButtonLink } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { PageHeader } from "../components/ui/PageHeader";

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="There is nothing at this address." />
      <EmptyState
        icon={SearchX}
        title="We couldn't find that page"
        action={
          <ButtonLink to="/" variant="primary">
            Back to Fleet
          </ButtonLink>
        }
      >
        The link may be out of date, or the page has not been built yet.
      </EmptyState>
    </>
  );
}
