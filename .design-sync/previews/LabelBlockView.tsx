import { LabelBlockView } from 'hisohiso-app';

const frame = { maxWidth: 380, margin: '0 auto' };

export const SectionLabel = () => (
  <div style={frame}>
    <LabelBlockView block={{ type: 'label', text: 'Changed files' }} />
  </div>
);

export const StepLabel = () => (
  <div style={frame}>
    <LabelBlockView block={{ type: 'label', text: 'Step 2 of 4' }} />
  </div>
);

export const ReviewLabel = () => (
  <div style={frame}>
    <LabelBlockView block={{ type: 'label', text: 'Ready to review' }} />
  </div>
);
