// Hand-written footprints for power parts. The JLCPCB/EasyEDA versions carry
// thermal vias with no net, which a ground pour would short to the pad's net
// (fatal under a MOSFET drain), so these have pads only. Pad positions are
// copied from the EasyEDA footprints; thermal vias are left to layout review.

/** DFN5x6 / SO-8FL power MOSFET (AON6354): pins 1-3 source, 4 gate, 5-8 + tab drain. */
export const DfnFet5x6Footprint = () => (
  <footprint>
    {[-1.905, -0.635, 0.635, 1.905].map((x, i) => (
      <smtpad key={`b${i}`} shape="rect" width="0.6mm" height="1.0mm" pcbX={x} pcbY={-2.92} portHints={[`pin${i + 1}`]} />
    ))}
    {[1.905, 0.635, -0.635, -1.905].map((x, i) => (
      <smtpad key={`t${i}`} shape="rect" width="0.6mm" height="1.0mm" pcbX={x} pcbY={2.92} portHints={[`pin${i + 5}`]} />
    ))}
    <smtpad shape="rect" width="4.2mm" height="3.5mm" pcbX={0} pcbY={0.8} portHints={["pin9"]} />
    <silkscreenpath route={[{ x: -2.6, y: -3.7 }, { x: -2.6, y: 3.7 }, { x: 2.6, y: 3.7 }, { x: 2.6, y: -3.7 }, { x: -2.6, y: -3.7 }]} />
  </footprint>
)

/** SO-8 PowerPAD (TI DDA): pins 1-4 bottom row, 5-8 top row, exposed pad = pin9. */
export const So8PowerpadFootprint = () => (
  <footprint>
    {[-1.905, -0.635, 0.635, 1.905].map((x, i) => (
      <smtpad key={`b${i}`} shape="rect" width="0.6mm" height="2.0mm" pcbX={x} pcbY={-2.77} portHints={[`pin${i + 1}`]} />
    ))}
    {[1.905, 0.635, -0.635, -1.905].map((x, i) => (
      <smtpad key={`t${i}`} shape="rect" width="0.6mm" height="2.0mm" pcbX={x} pcbY={2.77} portHints={[`pin${i + 5}`]} />
    ))}
    <smtpad shape="rect" width="3.1mm" height="2.4mm" pcbX={0} pcbY={0} portHints={["pin9"]} />
    <silkscreenpath route={[{ x: -2.5, y: -1.6 }, { x: -2.5, y: 1.6 }, { x: 2.5, y: 1.6 }, { x: 2.5, y: -1.6 }, { x: -2.5, y: -1.6 }]} />
  </footprint>
)
