import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

type QrModalProps = {
  open: boolean;
  onClose: () => void;
  value: string;
};

const QrModal = ({ open, onClose, value }: QrModalProps) => {
  const [src, setSrc] = useState<string>('');

  useEffect(() => {
    let active = true;
    const generate = async () => {
      if (!open || !value) {
        setSrc('');
        return;
      }
      const url = await QRCode.toDataURL(value, { width: 320, margin: 1 });
      if (active) {
        setSrc(url);
      }
    };

    void generate();
    return () => {
      active = false;
    };
  }, [open, value]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-6">
      <div className="w-full max-w-sm rounded-[22px] border border-rule bg-surface p-6 text-ink shadow-[0_20px_60px_-20px_rgba(10,10,10,0.3)]">
        <p className="text-[11px] uppercase tracking-[0.32em] text-ink-dim">Channel link</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em]">Scan to join</h2>
        <p className="mt-2 text-sm text-ink-soft">Losing this link means losing access.</p>
        <div className="mt-5 flex justify-center">
          {src ? <img src={src} alt="Channel QR code" className="h-56 w-56" /> : <div className="text-sm text-ink-dim">Loading…</div>}
        </div>
        <button
          className="mt-6 w-full rounded-full border border-ink bg-ink px-4 py-2.5 text-sm font-medium text-on-ink transition hover:bg-transparent hover:text-ink"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </div>
  );
};

export default QrModal;
