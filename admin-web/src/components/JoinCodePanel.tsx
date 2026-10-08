import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { AdminApi } from '../lib/api';
import { joinLink } from '../lib/format';
import { Modal, errorMessage, useToast } from './ui';

/**
 * How players reach the trail (decision 2026-10-07): the code, a link, and a QR for posters.
 * The link points at this server's /join/ page, which hands off to the app.
 */
export function JoinCodePanel({
  api,
  trailId,
  joinCode,
  published,
  onRotated,
}: {
  api: AdminApi;
  trailId: string;
  joinCode: string;
  published: boolean;
  onRotated: (joinCode: string) => void;
}) {
  const notify = useToast();
  const [showQr, setShowQr] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const link = joinLink(window.location.origin, joinCode);

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify(`${what} copied.`);
    } catch {
      notify(`Couldn't copy — select the ${what.toLowerCase()} and copy it manually.`, 'error');
    }
  }

  async function rotate() {
    setRotating(true);
    try {
      const result = await api.rotateJoinCode(trailId);
      onRotated(result.joinCode);
      notify(`New code ${result.joinCode}. The old code, links and QR codes no longer work.`);
    } catch (err) {
      notify(errorMessage(err), 'error');
    } finally {
      setRotating(false);
      setConfirmRotate(false);
    }
  }

  return (
    <div className="stack">
      <div className="row">
        <h3>Join code</h3>
        <span className="spacer" />
        {!published && <span className="badge">Works once published</span>}
      </div>
      <div className="row">
        <span className="code-chip" style={{ fontSize: '1.25rem' }}>
          {joinCode}
        </span>
        <span className="spacer" />
        <button className="small" onClick={() => void copy(joinCode, 'Code')}>
          Copy code
        </button>
      </div>
      <div className="row">
        <button className="small" onClick={() => void copy(link, 'Link')}>
          Copy link
        </button>
        <button className="small" onClick={() => setShowQr(true)}>
          QR code
        </button>
        <span className="spacer" />
        <button className="small danger" onClick={() => setConfirmRotate(true)}>
          New code…
        </button>
      </div>

      {showQr && <QrModal link={link} joinCode={joinCode} onClose={() => setShowQr(false)} />}

      {confirmRotate && (
        <Modal title="Issue a new join code?" onClose={() => setConfirmRotate(false)}>
          <p style={{ margin: 0 }}>
            The current code <strong className="code-chip">{joinCode}</strong> stops working
            immediately — including every link and printed QR code that uses it. Players already on
            the trail keep playing.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Use this when a code has been shared somewhere it shouldn't have.
          </p>
          <div className="modal-actions">
            <button onClick={() => setConfirmRotate(false)}>Keep current code</button>
            <button className="primary" disabled={rotating} onClick={() => void rotate()}>
              {rotating ? 'Issuing…' : 'Issue new code'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function QrModal({
  link,
  joinCode,
  onClose,
}: {
  link: string;
  joinCode: string;
  onClose: () => void;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // High error correction: posters get scuffed, folded and photographed at an angle.
    QRCode.toDataURL(link, { width: 1024, margin: 2, errorCorrectionLevel: 'H' })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [link]);

  return (
    <Modal title={`QR code for ${joinCode}`} onClose={onClose}>
      <div className="qr">
        {dataUrl ? <img src={dataUrl} alt={`QR code linking to ${link}`} /> : 'Generating…'}
      </div>
      <p className="muted mono" style={{ margin: 0, wordBreak: 'break-all' }}>
        {link}
      </p>
      <div className="modal-actions">
        <button onClick={onClose}>Close</button>
        {dataUrl && (
          <a className="button primary" href={dataUrl} download={`trail-${joinCode}.png`}>
            Download PNG
          </a>
        )}
      </div>
    </Modal>
  );
}
