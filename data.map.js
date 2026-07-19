// data.map.js
export const MAP = {
  regions: [
    { id: "R-01", name: "Kestrel Port", type: "PORT", x: 120, y: 140 },
    { id: "R-02", name: "Vesper Ridge", type: "WILDS", x: 260, y: 80 },
    { id: "R-03", name: "Helio Habitat", type: "HABITAT", x: 400, y: 140 },
    { id: "R-04", name: "Arc Relay", type: "COMMS", x: 520, y: 90 },
    { id: "R-05", name: "Grove Basin", type: "WILDS", x: 640, y: 150 },
    { id: "R-06", name: "Icarus Power", type: "POWER", x: 740, y: 90 },

    { id: "R-07", name: "Dustline Junction", type: "INDUSTRY", x: 180, y: 280 },
    { id: "R-08", name: "Sable Flats", type: "WILDS", x: 320, y: 250 },
    { id: "R-09", name: "Orchid Habitat", type: "HABITAT", x: 460, y: 270 },
    { id: "R-10", name: "South Relay", type: "COMMS", x: 560, y: 320 },
    { id: "R-11", name: "Kappa Foundry", type: "INDUSTRY", x: 680, y: 280 },
    { id: "R-12", name: "Redwater Port", type: "PORT", x: 780, y: 320 }
  ],
  links: [
    { id: "L-01-02", a: "R-01", b: "R-02", capacity: 2, terrain: "RIDGE", visibility: 0.7 },
    { id: "L-02-03", a: "R-02", b: "R-03", capacity: 2, terrain: "RIDGE", visibility: 0.8 },
    { id: "L-03-04", a: "R-03", b: "R-04", capacity: 1, terrain: "URBAN", visibility: 0.9 },
    { id: "L-04-05", a: "R-04", b: "R-05", capacity: 2, terrain: "PLAINS", visibility: 0.7 },
    { id: "L-05-06", a: "R-05", b: "R-06", capacity: 2, terrain: "RIDGE", visibility: 0.6 },

    { id: "L-01-07", a: "R-01", b: "R-07", capacity: 3, terrain: "PLAINS", visibility: 0.6 },
    { id: "L-07-08", a: "R-07", b: "R-08", capacity: 2, terrain: "PLAINS", visibility: 0.6 },
    { id: "L-08-09", a: "R-08", b: "R-09", capacity: 2, terrain: "URBAN", visibility: 0.8 },
    { id: "L-09-10", a: "R-09", b: "R-10", capacity: 1, terrain: "URBAN", visibility: 0.9 },
    { id: "L-10-11", a: "R-10", b: "R-11", capacity: 2, terrain: "PLAINS", visibility: 0.7 },
    { id: "L-11-12", a: "R-11", b: "R-12", capacity: 2, terrain: "PLAINS", visibility: 0.7 },

    { id: "L-05-11", a: "R-05", b: "R-11", capacity: 1, terrain: "WILDS", visibility: 0.5 },
    { id: "L-03-09", a: "R-03", b: "R-09", capacity: 1, terrain: "WILDS", visibility: 0.5 }
  ]
};