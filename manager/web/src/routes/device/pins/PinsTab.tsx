import { Button } from "../../../components/ui";
import { AddonsSection } from "../addons/AddonsSection";
import { RulesSection } from "../rules/RulesSection";
import { PinsSection } from "./PinsSection";
import "./pins.css";

const jump = (sectionId: string) => document.getElementById(sectionId)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** "Pins & add-ons" tab: pinout + pin list (Pins), then Add-ons and Rules. The wrappers carry the anchors the jump buttons use. */
export function PinsTab({ id }: { id: string }) {
  return (
    <div className="pins-tab">
      <div className="row" role="group" aria-label="Jump to section">
        <Button size="sm" onClick={() => jump("sec-pins")}>
          Pins
        </Button>
        <Button size="sm" onClick={() => jump("sec-addons")}>
          Add-ons
        </Button>
        <Button size="sm" onClick={() => jump("sec-rules")}>
          Rules
        </Button>
      </div>
      <PinsSection id={id} />
      <div id="sec-addons" className="pins-anchor">
        <AddonsSection id={id} />
      </div>
      <div id="sec-rules" className="pins-anchor">
        <RulesSection id={id} />
      </div>
    </div>
  );
}
