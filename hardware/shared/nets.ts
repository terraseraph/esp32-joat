// Pure helpers over circuit JSON, shared by the API (api/connect.ts) and the app (Connect panels).
export type PinRef = { ref: string; pin: string }
export type NetPin = PinRef & { sourcePortId: string; sourceComponentId: string }
export type NetInfo = { name: string; key: string; pins: NetPin[]; components: string[]; isGround: boolean; isPower: boolean }
export type PortInfo = PinRef & {
  sourcePortId: string; sourceComponentId: string; schematicPortId?: string; schematicComponentId?: string
  net?: string; hints: string[]
}
export type CircuitIndex = {
  nets: NetInfo[]
  ports: Record<string, PortInfo> // by source_port_id
  portBySchematic: Record<string, string> // schematic_port_id -> source_port_id
  components: { ref: string; sourceComponentId: string; schematicComponentId?: string; pins: PortInfo[] }[]
}

export function indexCircuit(circuit: any[]): CircuitIndex {
  const comps: Record<string, any> = {}
  const schComp: Record<string, string> = {}
  const schPort: Record<string, any> = {}
  for (const e of circuit) {
    if (e.type === "source_component") comps[e.source_component_id] = e
    else if (e.type === "schematic_component") schComp[e.source_component_id] = e.schematic_component_id
    else if (e.type === "schematic_port") schPort[e.source_port_id] = e
  }
  const ports: Record<string, PortInfo> = {}
  const byKey: Record<string, string[]> = {}
  for (const e of circuit) {
    if (e.type !== "source_port") continue
    const c = comps[e.source_component_id]
    if (!c) continue
    const sp = schPort[e.source_port_id]
    ports[e.source_port_id] = {
      ref: c.name, pin: e.name ?? `pin${e.pin_number}`, sourcePortId: e.source_port_id, sourceComponentId: e.source_component_id,
      schematicPortId: sp?.schematic_port_id, schematicComponentId: schComp[e.source_component_id], hints: e.port_hints ?? [],
    }
    if (e.subcircuit_connectivity_map_key) (byKey[e.subcircuit_connectivity_map_key] ??= []).push(e.source_port_id)
  }
  const netByKey: Record<string, any[]> = {}
  for (const e of circuit) if (e.type === "source_net" && e.subcircuit_connectivity_map_key) (netByKey[e.subcircuit_connectivity_map_key] ??= []).push(e)
  const nets: NetInfo[] = []
  for (const key of new Set([...Object.keys(byKey), ...Object.keys(netByKey)])) {
    const ids = byKey[key] ?? []
    const named = netByKey[key]
    if (!named && ids.length < 2) continue // lone unconnected pin
    const name = named?.[0]?.name ?? `(unnamed ${ids.map((i) => `${ports[i].ref}.${ports[i].pin}`).slice(0, 2).join("–")})`
    const pins = ids.map((i) => ({ ref: ports[i].ref, pin: ports[i].pin, sourcePortId: i, sourceComponentId: ports[i].sourceComponentId }))
    for (const i of ids) ports[i].net = name
    nets.push({
      name, key, pins, components: [...new Set(pins.map((p) => p.ref))],
      isGround: !!named?.some((n) => n.is_ground), isPower: !!named?.some((n) => n.is_power || n.is_positive_voltage_source),
    })
  }
  nets.sort((a, b) => b.pins.length - a.pins.length || a.name.localeCompare(b.name))
  const components = Object.values(comps).map((c: any) => ({
    ref: c.name as string, sourceComponentId: c.source_component_id as string, schematicComponentId: schComp[c.source_component_id],
    pins: Object.values(ports).filter((p) => p.sourceComponentId === c.source_component_id),
  }))
  return { nets, ports, portBySchematic: Object.fromEntries(Object.values(ports).filter((p) => p.schematicPortId).map((p) => [p.schematicPortId!, p.sourcePortId])), components }
}

/** Auto-suggested name for a new net joining two pins. */
export function suggestNetName(a: PinRef, b?: PinRef, taken: string[] = []): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1")
  const base = clean(b ? `${a.ref}_${a.pin}` : `${a.ref}_${a.pin}`).toUpperCase()
  let n = base, i = 2
  while (taken.includes(n)) n = `${base}_${i++}`
  return n
}
