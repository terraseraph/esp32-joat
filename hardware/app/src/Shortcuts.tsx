import * as Dialog from "@radix-ui/react-dialog"

export const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + S", "Save"],
  ["Ctrl/⌘ + Z", "Undo (outside the editor)"],
  ["Ctrl/⌘ + Shift + Z", "Redo"],
  ["Ctrl/⌘ + Enter", "Build (outside the editor)"],
  ["1 / 2 / 3", "Schematic / PCB / 3D"],
  ["J", "Toggle bottom panel"],
  ["E", "Open and focus the code editor"],
  ["Esc", "Leave the editor / clear the PCB selection"],
  ["Arrows", "Nudge the selected part by the snap step"],
  ["R / Shift + R", "Rotate the selected part 90°"],
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
