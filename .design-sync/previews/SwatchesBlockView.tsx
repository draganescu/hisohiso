import { SwatchesBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const BrandPalette = () => (
  <div style={frame}>
    <SwatchesBlockView
      block={{
        type: 'swatches',
        title: 'Riso brand palette',
        schemes: [
          {
            name: 'Core inks',
            note: 'The two-color riso base — everything else derives from these.',
            colors: [
              { hex: '#1b1a17', name: 'Ink' },
              { hex: '#f4f1ea', name: 'Paper' },
              { hex: '#ff5c39', name: 'Tang' },
              { hex: '#3b6ef5', name: 'Cobalt' },
            ],
          },
        ],
      }}
    />
  </div>
);

export const LightVsDark = () => (
  <div style={frame}>
    <SwatchesBlockView
      block={{
        type: 'swatches',
        title: 'Surface ramps',
        schemes: [
          {
            name: 'Light',
            note: 'Daylight reading surfaces',
            colors: [
              { hex: '#ffffff', name: 'bg' },
              { hex: '#f4f1ea', name: 'surface' },
              { hex: '#e6e1d6', name: 'rule' },
              { hex: '#1b1a17', name: 'ink' },
            ],
          },
          {
            name: 'Dark',
            note: 'Dimmed evening surfaces',
            colors: [
              { hex: '#14130f', name: 'bg' },
              { hex: '#1f1d18', name: 'surface' },
              { hex: '#33302a', name: 'rule' },
              { hex: '#f4f1ea', name: 'ink' },
            ],
          },
        ],
      }}
    />
  </div>
);

export const StatusAccents = () => (
  <div style={frame}>
    <SwatchesBlockView
      block={{
        type: 'swatches',
        title: 'Semantic accents',
        schemes: [
          {
            name: 'Diff & status',
            note: 'Reserved for code add/remove and run results.',
            colors: [
              { hex: '#2f9e44', name: 'add' },
              { hex: '#e03131', name: 'del' },
              { hex: '#f59f00', name: 'warn' },
              { hex: '#3b6ef5', name: 'info' },
            ],
          },
        ],
      }}
    />
  </div>
);
