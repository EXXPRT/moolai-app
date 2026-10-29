import { visibleLinksBetween } from "../../../packages/contracts/src/records.js";
import { useEffect, useRef } from "react";
import cytoscape from "cytoscape";
import type { BrainRecord } from "../../../packages/contracts/src/index.js";
import { noteTitle, relatedRecords } from "../../../packages/contracts/src/records.js";
import type { SessionHub } from "./session-hubs.js";

export default function BrainGraph({ record, records, onSelect, overview = false, sessions = [], status }: {
  record?: BrainRecord; records: BrainRecord[]; onSelect: (id: string) => void; overview?: boolean; sessions?: SessionHub[];
  status?: { label: string; tone: "busy" | "done" | "attention" };
}) {
  const container = useRef<HTMLDivElement>(null);
  const graph = useRef<cytoscape.Core | null>(null);
  const select = useRef(onSelect);
  select.current = onSelect;
  const available = records.filter(item => item.kind !== "session" && !item.sourceOnly && !item.archived && !item.suppressed);
  const neighbours = record ? relatedRecords(available, record.id) : [];
  // Notes from the same study session follow the linked neighbours, within the same cap.
  const sameSession = record ? sessions.filter(hub => hub.members.includes(record.id)).flatMap(hub => hub.members) : [];
  const siblings = available.filter(item => item.id !== record?.id && sameSession.includes(item.id));
  const initial = overview ? available.slice(0, 100) : record ? [record] : [];
  const visible = [...new Map([...initial,
    ...(record && !record.sourceOnly && !record.suppressed && !record.archived && record.kind !== "session" ? [record] : []),
    ...[...new Set([...neighbours, ...siblings])].slice(0, 30),
  ].map(item => [item.id, item])).values()];
  const shown = new Set(visible.map(item => item.id));
  const hubs = sessions.map(hub => ({ ...hub, members: hub.members.filter(id => shown.has(id)) })).filter(hub => hub.members.length >= 2);
  const signature = JSON.stringify({ items: visible.map(item => ({ id: item.id, title: noteTitle(item, available), links: item.links })), hubs });

  function animateViewport(viewport: { zoom?: number; pan?: cytoscape.Position; fit?: { eles: cytoscape.CollectionReturnValue; padding: number } }) {
    const cy = graph.current;
    if (!cy) return;
    cy.stop();
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (viewport.fit) cy.fit(viewport.fit.eles, viewport.fit.padding);
      else { if (viewport.zoom !== undefined) cy.zoom(viewport.zoom); if (viewport.pan) cy.pan(viewport.pan); }
    } else cy.animate(viewport, { duration: 220, easing: "ease-out" });
  }
  function zoom(multiplier: number) {
    const cy = graph.current;
    if (!cy || !container.current) return;
    const next = Math.min(cy.maxZoom(), Math.max(cy.minZoom(), cy.zoom() * multiplier));
    const center = { x: container.current.clientWidth / 2, y: container.current.clientHeight / 2 };
    const scale = next / cy.zoom(), pan = cy.pan();
    animateViewport({ zoom: next, pan: { x: center.x - (center.x - pan.x) * scale, y: center.y - (center.y - pan.y) * scale } });
  }

  useEffect(() => {
    if (!container.current) return;
    const cy = cytoscape({
      container: container.current, elements: [], minZoom: .2, maxZoom: 2.5, wheelSensitivity: .18,
      style: [
        { selector: "node", style: {
          "background-color": "#839a79", width: 24, height: 24, label: "data(label)",
          "font-family": "-apple-system, BlinkMacSystemFont, sans-serif", "font-size": 12,
          color: "#435441", "text-valign": "bottom", "text-margin-y": 9,
          "text-wrap": "wrap", "text-max-width": "100px", "border-width": 5, "border-color": "#e6eddf",
        } },
        { selector: "node.selected", style: { "background-color": "#334e3d", "border-color": "#c6d6bd", width: 31, height: 31, "font-weight": "bold", color: "#253b2e" } },
        { selector: "edge", style: { width: 1.5, "line-color": "#a4b397", "curve-style": "bezier", opacity: .7 } },
        { selector: 'edge[kind = "manual"]', style: { "line-color": "#7893aa", width: 1.8 } },
        { selector: 'edge[kind = "source"]', style: { "line-color": "#b5a27b", "line-style": "dotted" } },
        { selector: "edge[suggestion = 1]", style: { "line-style": "dashed" } },
        { selector: "node.session", style: { "background-color": "#f7f3e8", "border-color": "#c2b28c", "border-width": 2, width: 16, height: 16, "font-size": 10, "font-style": "italic", color: "#7d6f52" } },
        { selector: 'edge[kind = "session"]', style: { width: 1, "line-color": "#d8cfb8", opacity: .6 } },
      ],
    });
    graph.current = cy;
    // A session hub is not a note: tapping it brings its notes into view instead of opening it.
    cy.on("tap", "node", event => event.target.hasClass("session")
      ? animateViewport({ fit: { eles: event.target.closedNeighborhood(), padding: 60 } })
      : select.current(event.target.id()));
    let width = container.current.clientWidth, height = container.current.clientHeight;
    const resize = new ResizeObserver(() => {
      if (!container.current) return;
      const nextWidth = container.current.clientWidth, nextHeight = container.current.clientHeight, pan = cy.pan();
      cy.resize(); cy.pan({ x: pan.x + (nextWidth - width) / 2, y: pan.y + (nextHeight - height) / 2 });
      width = nextWidth; height = nextHeight;
    });
    resize.observe(container.current);
    return () => { resize.disconnect(); cy.destroy(); graph.current = null; };
  }, []);

  useEffect(() => {
    const cy = graph.current;
    if (!cy) return;
    const { items, hubs } = JSON.parse(signature) as { items: { id: string; title: string; links: BrainRecord["links"] }[]; hubs: SessionHub[] };
    const before = cy.nodes().length, count = items.length + hubs.length;
    const extent = cy.extent(), center = { x: (extent.x1 + extent.x2) / 2, y: (extent.y1 + extent.y2) / 2 };
    const elements: cytoscape.ElementDefinition[] = [...items.map(item => ({ id: item.id, label: item.title })),
      ...hubs.map(hub => ({ id: hub.id, label: hub.label }))].map((data, index) => ({
      data, classes: index < items.length ? undefined : "session",
      // Cytoscape keeps the object it is given as the node's position, so a shared one would move every new node together.
      position: before ? { ...center }
        : { x: 180 + (index % 8) * 120, y: 120 + Math.floor(index / 8) * 120 },
    }));
    const edges = new Set<string>();
    for (const item of items) for (const link of item.links) {
      const target=items.find(other=>other.id===link.targetId);
      if (!target || !visibleLinksBetween(item,target).includes(link)) continue;
      const id = `edge:${[item.id, link.targetId].sort().join(":")}:${link.provenance}`;
      if (edges.has(id)) continue;
      edges.add(id);
      elements.push({ data: { id, source: item.id, target: link.targetId, kind: link.provenance,
        suggestion: link.provenance === "suggested" && link.decision !== "accepted" ? 1 : 0 } });
    }
    for (const hub of hubs) for (const member of hub.members)
      elements.push({ data: { id: `edge:${hub.id}:${member}:session`, source: hub.id, target: member, kind: "session", suggestion: 0 } });
    const desired = new Set(elements.map(element => element.data.id!));
    const incoming: cytoscape.NodeSingular[] = [];
    cy.batch(() => {
      cy.elements().filter(element => !desired.has(element.id())).remove();
      for (const item of elements) {
        const existing = cy.getElementById(item.data.id!);
        if (existing.length) existing.data(item.data);
        else {
          const added = cy.add(item);
          if (added.isNode()) incoming.push(added[0] as cytoscape.NodeSingular);
        }
      }
    });
    if (before && incoming.length) {
      const incomingIds = new Set(incoming.map(node => node.id()));
      const occupied = cy.nodes().filter(node => !incomingIds.has(node.id())).map(node => node.boundingBox());
      for (const node of incoming) {
        // Search outward for a free label-sized space; never move existing notes.
        for (let attempt = 0; attempt <= occupied.length * 16 + 32; attempt++) {
          const distance = 70 * Math.sqrt(attempt), angle = attempt * 2.4;
          node.position({ x: center.x + Math.cos(angle) * distance, y: center.y + Math.sin(angle) * distance });
          const box = node.boundingBox();
          if (!occupied.some(other => box.x1 < other.x2 + 20 && box.x2 > other.x1 - 20 && box.y1 < other.y2 + 20 && box.y2 > other.y1 - 20)) break;
          if (attempt === occupied.length * 16 + 32) {
            const edge = Math.max(...occupied.map(other => other.x2));
            node.position({ x: edge + box.w / 2 + 32, y: center.y });
          }
        }
        occupied.push(node.boundingBox());
      }
    }
    if (!before && count) {
      // A sparse brain needs balanced space for titles, not force-layout component packing.
      // Node labels stay readable as larger brains grow beyond the current viewport.
      const sparse = cy.edges().length < count / 2;
      if (sparse) {
        const columns = Math.max(1, Math.ceil(Math.sqrt(count * cy.width() / Math.max(1, cy.height()) / 1.6)));
        const rows = Math.ceil(count / columns);
        cy.layout({ name: "grid", animate: false, fit: true, padding: 46, cols: columns,
          nodeDimensionsIncludeLabels: true, avoidOverlap: true, avoidOverlapPadding: 24,
          boundingBox: { x1: 0, y1: 0, w: Math.max(columns * 132, cy.width() - 96), h: Math.max(rows * 95, cy.height() - 100) },
        }).run();
      } else {
        cy.layout({ name: "concentric", animate: false, fit: true, padding: 46,
          nodeDimensionsIncludeLabels: true, minNodeSpacing: 40,
          concentric: node => node.degree(), levelWidth: () => 2,
        }).run();
      }
      cy.zoom(Math.max(.9, Math.min(1, cy.zoom()))); cy.center();
    }
    // Existing positions are part of the user's workspace. New notes are placed
    // around the viewport above; label and link updates must not rearrange them.
  }, [signature]);
  useEffect(() => {
    graph.current?.nodes().removeClass("selected");
    if (record) graph.current?.getElementById(record.id).addClass("selected");
  }, [record?.id, signature]);

  return <div className="graph-panel">
    <div ref={container} className="brain-graph" tabIndex={0} role="region" aria-label={`Related notes graph, ${visible.length} notes`} aria-describedby="graph-keyboard-help" data-node-count={visible.length} onKeyDown={event => {
      if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.25); }
      else if (event.key === "-") { event.preventDefault(); zoom(.8); }
      else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        event.preventDefault(); const cy = graph.current; if (!cy) return;
        const pan = cy.pan(); animateViewport({ pan: { x: pan.x + (event.key === "ArrowLeft" ? 45 : event.key === "ArrowRight" ? -45 : 0), y: pan.y + (event.key === "ArrowUp" ? 45 : event.key === "ArrowDown" ? -45 : 0) } });
      }
    }} />
    {!visible.length ? <div className="graph-empty"><span aria-hidden="true">✧</span><p>A little space for your next idea.</p><small>Your thoughts and their connections will grow here.</small></div> : null}
    <div className="graph-toolbar">
      {status ? <span className={`graph-organizing ${status.tone}`} role="status" aria-live="polite">{status.label}</span> : null}
      <span className="graph-scope">{visible.length} of {available.length} notes{hubs.length ? ` · ${hubs.length} session${hubs.length === 1 ? "" : "s"}` : ""}{overview ? " · recent + connected" : " · neighbourhood"}</span>
      <div className="graph-controls" aria-label="Graph controls"><button className="icon-button" aria-label="Zoom out" title="Zoom out" onClick={() => zoom(.8)}>−</button><button className="icon-button" aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1.25)}>+</button><button className="text-button" onClick={() => { const cy = graph.current; if (cy?.nodes().length) animateViewport({ fit: { eles: cy.elements(), padding: 60 } }); }}>Fit</button></div>
    </div>
    <span id="graph-keyboard-help" className="sr-only">Select notes using the recent thoughts above. Drag to pan or scroll to zoom. When this graph is focused, use arrow keys to pan and plus or minus to zoom.</span>
  </div>;
}
