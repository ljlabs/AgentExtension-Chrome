import { closePermission } from "../agent/controller.js";

export default function PermissionModal({ permission }) {
  if (!permission) return null;

  return (
    <div id="modalBackdrop" className="modal-backdrop">
      <div className="modal">
        <h3 id="modalTitle">{permission.kind === "image" ? "Image permission" : "Network permission"}</h3>
        <p id="modalBody">{permission.message} Allow?</p>

        <div className="modal-actions">
          <button
            id="modalAllowOnce"
            className="btn primary"
            type="button"
            onClick={() => closePermission({ allow: true, scope: "once" })}
          >
            Allow once
          </button>
          <button
            id="modalAllowSession"
            className="btn"
            type="button"
            onClick={() => closePermission({ allow: true, scope: "session" })}
          >
            Allow for session
          </button>
          <button
            id="modalDeny"
            className="btn danger"
            type="button"
            onClick={() => closePermission({ allow: false, scope: "session" })}
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}
