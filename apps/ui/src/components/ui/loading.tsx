export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div className={`inline-block h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-indigo-500 ${className}`} />
  );
}

export function LoadingState({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-zinc-500">
      <Spinner className="h-8 w-8" />
      <p className="text-sm">{message}</p>
    </div>
  );
}
