import Modal from "react-modal";
import cstyles from "../common/Common.module.css";
import { useContext } from "react";
import { ContextApp } from "../../context/ContextAppState";
import { native } from "../../electronBridge";

type ConfirmModalProps = {
  closeModal: () => void;
};

const ConfirmModal: React.FC<ConfirmModalProps> = ({ closeModal }) => {
  const context = useContext(ContextApp);
  const { confirmModal } = context;
  const { title, body, modalIsOpen, runAction } = confirmModal;
  const cancel = () => {
    void native.cancel_transaction_proposal().catch((error) => {
      console.error("cancel_transaction_proposal", error);
    });
    closeModal();
  };

  return (
    <Modal
      isOpen={modalIsOpen}
      onRequestClose={cancel}
      className={cstyles.modal}
      overlayClassName={cstyles.modalOverlay}
    >
      <div className={cstyles.verticalflex}>
        <div className={cstyles.marginbottomlarge} style={{ textAlign: "center" }}>
          {title}
        </div>

        <div
          className={cstyles.well}
          style={{ textAlign: "center", wordBreak: "break-all", maxHeight: "400px", overflowY: "auto" }}
        >
          {body}
        </div>
      </div>

      <div className={cstyles.verticalflex} style={{ justifyContent: "center", alignItems: "center" }}>
        <div className={cstyles.horizontalflex}>
          <div className={cstyles.buttoncontainer}>
            <button type="button" className={cstyles.primarybutton} onClick={cancel}>
              Cancel
            </button>
          </div>
          <div className={cstyles.buttoncontainer}>
            <button
              type="button"
              className={cstyles.primarybutton}
              onClick={() => {
                runAction();
                closeModal();
              }}
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default ConfirmModal;
