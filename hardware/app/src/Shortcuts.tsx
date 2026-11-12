import * as Dialog from "@radix-ui/react-dialog"

export const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + S", "Save"],
  ["Ctrl/⌘ + Enter", "Build"],
  ["1 / 2 / 3", "Schematic / PCB / 3D"],
  ["J", "Toggle bottom panel"],
  ["E", "Focus code editor"],
  ["Esc", "Leave the editor"],
  ["?", "Show this list"],
]

export default function Shortcuts({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" style={{ width: 360 }} aria-describedby={undefined}>
          <Dialog.Title className="modal-title">Keyboard shortcuts</Dialog.Title>
          <dl className="kbd-list">
            {SHORTCUTS.map(([k, d]) => (
              <div key={k} style={{ display: "contents" }}>
                <dt><kbd>{k}</kbd></dt>
                <dd>{d}</dd>
              </div>
            ))}
          </dl>
          <div className="small muted" style={{ marginTop: 12 }}>Single-key shortcuts are off while typing.</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
