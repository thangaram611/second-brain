import { useRef, useEffect } from 'react';
import cytoscape from 'cytoscape';
import type { Core, EventObject } from 'cytoscape';
import type { Entity, Relation } from '../../lib/types.js';
import { ENTITY_COLORS, RELATION_COLORS } from '../../lib/colors.js';
import type { LayoutName } from '../pages/graph-explorer.js';

interface GraphCanvasProps {
  entities: Entity[];
  relations: Relation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onExpand: (id: string) => void;
  layout: LayoutName;
}

/**
 * Build cytoscape layout options for one of our supported layouts. cytoscape's
 * `LayoutOptions` is a union discriminated on a string-LITERAL `name`, so an
 * object built from a `LayoutName` variable can't match it directly. Switching
 * on each name narrows it to a single literal per case, which type-checks
 * without a cast — and the exhaustive switch flags any future LayoutName that
 * isn't handled here. `animate: false` is deliberate (see the teardown note).
 */
function buildLayoutOptions(name: LayoutName, fit: boolean): cytoscape.LayoutOptions {
  switch (name) {
    case 'cose':
      return { name, animate: false, fit, nodeRepulsion: () => 8000, idealEdgeLength: () => 80 };
    case 'grid':
      return { name, animate: false, fit };
    case 'circle':
      return { name, animate: false, fit };
    case 'breadthfirst':
      return { name, animate: false, fit };
  }
}

function buildStylesheet(): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-size': 11,
        color: '#d4d4d8',
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'background-color': 'data(color)',
        width: 'data(size)',
        height: 'data(size)',
        'border-width': 0,
        'text-max-width': '100px',
        'text-wrap': 'ellipsis',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': '#818cf8',
        'border-opacity': 1,
      },
    },
    {
      selector: 'node.dimmed',
      style: {
        opacity: 0.3,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': 'data(color)',
        'target-arrow-color': 'data(color)',
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'arrow-scale': 0.8,
        opacity: 0.6,
      },
    },
    {
      selector: 'edge:selected',
      style: {
        width: 2.5,
        opacity: 1,
      },
    },
  ];
}

export function GraphCanvas({
  entities,
  relations,
  selectedId,
  onSelect,
  onExpand,
  layout,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutRef = useRef<LayoutName>(layout);
  // Handle to the currently-running (animated) layout. Animated layouts drive
  // node positions on requestAnimationFrame; if the instance is destroyed (or a
  // new layout starts) while frames are still queued, the stale frame calls into
  // a torn-down core ("Cannot read properties of null (reading 'notify')"). We
  // stop the previous layout before starting another and before destroy.
  const runningLayoutRef = useRef<cytoscape.Layouts | null>(null);

  // Initialize Cytoscape
  useEffect(() => {
    if (!containerRef.current) return;

    const cy = cytoscape({
      container: containerRef.current,
      style: buildStylesheet(),
      minZoom: 0.2,
      maxZoom: 5,
      wheelSensitivity: 0.3,
    });

    cyRef.current = cy;

    return () => {
      // Stop any in-flight animated layout so its queued frames don't run
      // against the destroyed instance.
      runningLayoutRef.current?.stop();
      runningLayoutRef.current = null;
      cy.destroy();
      cyRef.current = null;
    };
  }, []);

  // Register event handlers
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    function handleTap(e: EventObject) {
      if (e.target === cy) return; // clicked on background
      const id = e.target.id();
      if (e.target.isNode()) {
        onSelect(id);
      }
    }

    function handleDoubleTap(e: EventObject) {
      if (e.target.isNode()) {
        onExpand(e.target.id());
      }
    }

    cy.on('tap', handleTap);
    cy.on('dbltap', 'node', handleDoubleTap);

    return () => {
      cy.off('tap', handleTap);
      cy.off('dbltap', 'node', handleDoubleTap);
    };
  }, [onSelect, onExpand]);

  // Sync elements
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const entityIds = new Set(entities.map((e) => e.id));

    // Build node/edge data
    const nodes = entities.map((e) => ({
      data: {
        id: e.id,
        label: e.name,
        type: e.type,
        color: ENTITY_COLORS[e.type] ?? '#6b7280',
        size: Math.max(20, Math.min(50, 20 + e.accessCount * 2)),
      },
    }));

    const edges = relations
      .filter((r) => entityIds.has(r.sourceId) && entityIds.has(r.targetId))
      .map((r) => ({
        data: {
          id: r.id,
          source: r.sourceId,
          target: r.targetId,
          label: r.type,
          color: RELATION_COLORS[r.type] ?? '#6b7280',
        },
      }));

    // Diff and update (avoid full re-render)
    const currentNodeIds = new Set(cy.nodes().map((n) => n.id()));
    const currentEdgeIds = new Set(cy.edges().map((e) => e.id()));
    const newNodeIds = new Set(nodes.map((n) => n.data.id));
    const newEdgeIds = new Set(edges.map((e) => e.data.id));

    // Remove stale
    cy.nodes().forEach((n) => {
      if (!newNodeIds.has(n.id())) n.remove();
    });
    cy.edges().forEach((e) => {
      if (!newEdgeIds.has(e.id())) e.remove();
    });

    // Add new
    const nodesToAdd = nodes.filter((n) => !currentNodeIds.has(n.data.id));
    const edgesToAdd = edges.filter((e) => !currentEdgeIds.has(e.data.id));

    if (nodesToAdd.length > 0 || edgesToAdd.length > 0) {
      cy.add([...nodesToAdd, ...edgesToAdd]);

      // Run layout. Use synchronous (non-animated) layout: animated layouts
      // drive positions on requestAnimationFrame, and a queued frame firing
      // after the component unmounts (or a new layout starts) calls into a
      // torn-down core → "Cannot read properties of null (reading 'notify')".
      // Stop any previous layout first as a safety net.
      runningLayoutRef.current?.stop();
      const nextLayout = cy.layout(buildLayoutOptions(layoutRef.current, nodesToAdd.length > 5));
      runningLayoutRef.current = nextLayout;
      nextLayout.run();
    }
  }, [entities, relations]);

  // Layout changes
  useEffect(() => {
    layoutRef.current = layout;
    const cy = cyRef.current;
    if (!cy || cy.elements().length === 0) return;

    runningLayoutRef.current?.stop();
    const nextLayout = cy.layout(buildLayoutOptions(layout, true));
    runningLayoutRef.current = nextLayout;
    nextLayout.run();
  }, [layout]);

  // Highlight selected
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().removeClass('dimmed');

    if (selectedId) {
      const selected = cy.getElementById(selectedId);
      if (selected.length > 0) {
        selected.select();
        const neighborhood = selected.neighborhood().add(selected);
        cy.nodes().not(neighborhood).addClass('dimmed');
      }
    } else {
      cy.nodes().unselect();
    }
  }, [selectedId]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-zinc-950"
    />
  );
}
