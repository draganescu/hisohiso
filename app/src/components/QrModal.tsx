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
      <div className="w-full max-w-sm rounded-[22px] border border-[#0a0a0a14] bg-white p-6 text-[#0a0a0a] shadow-[0_20px_60px_-20px_rgba(10,10,10,0.3)]">
        <p className="text-[11px] uppercase tracking-[0.32em] text-[#9a9a9a]">Channel link</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.02em]">Scan to join</h2>
        <p className="mt-2 text-sm text-[#6b6b6b]">Losing this link means losing access.</p>
        <div className="mt-5 flex justify-center">
          {src ? <img src={src} alt="Channel QR code" className="h-56 w-56" /> : <div className="text-sm text-[#9a9a9a]">Loading…</div>}
        </div>
        <button
          className="mt-6 w-full rounded-full border border-[#0a0a0a] bg-[#0a0a0a] px-4 py-2.5 text-sm font-medium text-white transition hover:bg-transparent hover:text-[#0a0a0a]"
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
