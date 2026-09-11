export function Icon({ name, className = '' }: { name: string; className?: string }) {
  const paths: Record<string, string> = {
    files: 'M8 3H4v14h12v-4 M8 7V2h8l4 4v15H8V7 M16 2v5h4',
    folder: 'M3 7V4h6l2 3h10v13H3V7Z',
    file: 'M5 2h9l5 5v15H5V2Z M14 2v6h5 M8 12h8 M8 16h6',
    image: 'M3 3h18v18H3Z M3 17l6-6 4 4 3-3 5 5 M15 7h.01',
    git: 'M6 6v12 M18 6v3c0 5-12 2-12 7 M9 3a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M9 21a3 3 0 1 1-6 0a3 3 0 1 1 6 0 M21 3a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
    inbox: 'M3 4h18v16H3Z M3 13h5l2 3h4l2-3h5',
    settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={`w-4 h-4 shrink-0 ${className}`}><path d={paths[name] ?? paths.file} /></svg>;
}
