/**
 * The "Paired Core" mark of the native app icon
 * (`src-tauri/icons/paired-core.svg`), for in-app brand surfaces that should
 * match the icon people launch. Same geometry and colors as the master.
 */
export function PairedCoreMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="16 16 480 480"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect fill="#0B0B0B" height="480" rx="112" width="480" x="16" y="16" />
      <path
        d="M148 80H312Q326 80 326 94V134Q326 148 312 148H174A26 26 0 0 0 148 174V324Q148 338 134 338H94Q80 338 80 324V148A68 68 0 0 1 148 80Z"
        fill="#CEDC2E"
      />
      <path
        d="M148 80H312Q326 80 326 94V134Q326 148 312 148H174A26 26 0 0 0 148 174V324Q148 338 134 338H94Q80 338 80 324V148A68 68 0 0 1 148 80Z"
        fill="#FFFFFF"
        transform="rotate(180 256 256)"
      />
      <circle cx="212" cy="256" fill="#CEDC2E" r="36" />
      <circle cx="300" cy="256" fill="#FFFFFF" r="36" />
    </svg>
  );
}
