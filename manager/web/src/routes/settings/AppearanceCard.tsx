import { Card } from "../../components/ui/Card";
import { Field } from "../../components/ui/Field";
import { Segmented } from "../../components/ui/Segmented";
import { THEME_LABEL, THEME_ORDER, setThemePref, useThemePref } from "../../lib/theme";

/** Theme (this browser only; the same state as the toggle in the side nav). */
export function AppearanceCard() {
  const pref = useThemePref();
  return (
    <Card aria-labelledby="s-appearance">
      <div className="card-head">
        <h2 id="s-appearance">Appearance</h2>
      </div>
      <Field label="Theme" hint="Applies to this browser only. System follows your device.">
        <Segmented value={pref} onChange={setThemePref} options={THEME_ORDER.map((v) => ({ value: v, label: THEME_LABEL[v] }))} />
      </Field>
    </Card>
  );
}
