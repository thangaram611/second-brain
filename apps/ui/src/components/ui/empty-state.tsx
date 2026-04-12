import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <h3 className="text-lg font-medium text-zinc-300">{title}</h3>
      {description && <p className="max-w-md text-sm text-zinc-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
