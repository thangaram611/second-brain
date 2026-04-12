import { Maximize, Grid3X3, Circle, GitBranch } from 'lucide-react';
import { Button } from '../ui/button.js';
import type { LayoutName } from '../pages/graph-explorer.js';

interface GraphControlsProps {
  layout: LayoutName;
  onLayoutChange: (layout: LayoutName) => void;
}

const layouts: { name: LayoutName; icon: typeof Grid3X3; label: string }[] = [
  { name: 'cose', icon: GitBranch, label: 'Force' },
  { name: 'grid', icon: Grid3X3, label: 'Grid' },
  { name: 'circle', icon: Circle, label: 'Circle' },
  { name: 'breadthfirst', icon: Maximize, label: 'Tree' },
];

export function GraphControls({ layout, onLayoutChange }: GraphControlsProps) {
  return (
    <div className="flex items-center gap-1">
      <span className="mr-2 text-xs text-zinc-500">Layout:</span>
      {layouts.map((l) => (
        <Button
          key={l.name}
          variant={layout === l.name ? 'primary' : 'ghost'}
          size="sm"
          onClick={() => onLayoutChange(l.name)}
          title={l.label}
        >
          <l.icon className="mr-1 h-3.5 w-3.5" />
          <span className="text-xs">{l.label}</span>
        </Button>
      ))}
    </div>
  );
}
