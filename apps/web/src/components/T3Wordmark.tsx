import type { SVGProps } from "react";

// Keep the upstream component API so every existing lockup uses the fork mark.
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
      <g transform="translate(256 256) scale(1.08) translate(-256 -256)">
        <g transform="translate(-57 -14) scale(1.058)">
          <path d="M396 406c54-4 74-28 74-70" fill="none" stroke="currentColor" strokeWidth="36" />
          <path
            fill="currentColor"
            d="M504 336H436l34-58zM104 68c24 40 46 56 86 58 44 4 88 4 132 0 40-2 62-18 86-58 12 40 16 72 16 122v182a72 72 0 0 1-72 72H160a72 72 0 0 1-72-72V190c0-50 4-82 16-122Z"
          />
          <rect width="272" height="256" x="120" y="158" fill="var(--brand-mark-canvas)" rx="46" />
          <path
            fill="none"
            stroke="var(--brand-mark-ink)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="30"
            d="m180 232 62 60-62 60m88 -6h72"
          />
        </g>
      </g>
    </svg>
  );
}
