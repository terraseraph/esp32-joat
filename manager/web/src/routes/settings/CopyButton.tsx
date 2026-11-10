import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Tooltip } from "../../components/ui/Tooltip";

/** Icon button that copies `text` to the clipboard and says "Copied" for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      // Clipboard blocked (plain http from another device is not a secure context): tell the user to copy by hand.
      setCopied(false);
      setFailed(true);
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 2000);
  }
  return (
    <>
      <Tooltip label={copied ? "Copied" : failed ? "Could not copy: select the text and copy it by hand" : label}>
        <Button size="sm" variant="ghost" iconOnly aria-label={label} onClick={() => void copy()}>
          {copied ? <Check className="i sm" aria-hidden="true" /> : <Copy className="i sm" aria-hidden="true" />}
        </Button>
      </Tooltip>
      <span className="sr" role="status">
        {copied ? "Copied" : failed ? "Could not copy" : ""}
      </span>
    </>
  );
}
