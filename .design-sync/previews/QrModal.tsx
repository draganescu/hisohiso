import { QrModal } from 'hisohiso-app';

// QrModal renders a `position: fixed inset-0` overlay (dark backdrop + centered
// dialog). A `transform` on the wrapper contains the fixed overlay so the whole
// modal — backdrop and card — renders inside the preview cell.
const frame = { maxWidth: 380, margin: '0 auto' };
const stage = {
  position: 'relative' as const,
  transform: 'translateZ(0)',
  minHeight: 460,
};

export const PairingDialog = () => (
  <div style={frame}>
    <div style={stage}>
      <QrModal
        open={true}
        onClose={() => {}}
        value="https://hiso.chat/r/AbC123#s=xyz"
      />
    </div>
  </div>
);
