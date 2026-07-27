// Each seat gets a glyph as well as an accent colour, so which side you are is
// still legible without colour vision, in monochrome, or at a glance.
export const SEATS = [
  { marker: '●', shape: 'circle' },
  { marker: '◆', shape: 'diamond' },
];

export const seatMarker = (seat) => SEATS[seat].marker;
export const seatShape = (seat) => SEATS[seat].shape;
