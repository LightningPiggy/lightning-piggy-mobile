export type OutgoingBubbleStyle = 'A' | 'B' | 'C';

// Exact proposal endpoints. A/C need a dark scrim for AA small-text contrast.
// `locations` are the gradient stops along the top-left → bottom-right
// diagonal: A stays brand pink for most of the bubble and only turns purple
// towards the bottom-right corner.
export const outgoingBubblePalettes = {
  A: {
    gradient: ['#EC008C', '#8B5CF6'],
    locations: [0.55, 1],
    foreground: '#FFFFFF',
    scrim: 'rgba(0,0,0,0.18)',
  },
  B: {
    gradient: ['#FDE7F3', '#F3E8FF'],
    locations: [0, 1],
    foreground: '#3B0A2A',
    scrim: 'transparent',
  },
  C: {
    gradient: ['#8B5CF6', '#C026D3'],
    locations: [0, 1],
    foreground: '#FFFFFF',
    scrim: 'rgba(0,0,0,0.18)',
  },
} satisfies Record<
  OutgoingBubbleStyle,
  { gradient: [string, string]; locations: [number, number]; foreground: string; scrim: string }
>;

export function resolveOutgoingBubbleStyle(stored: unknown): OutgoingBubbleStyle {
  return stored === 'B' || stored === 'C' ? stored : 'A';
}
