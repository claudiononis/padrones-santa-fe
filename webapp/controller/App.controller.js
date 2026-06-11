sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageToast",
  "sap/m/MessageBox"
], function (Controller, JSONModel, MessageToast, MessageBox) {
  "use strict";

  const INITIAL_STATE = {
    fileName: "",
    fileContent: "",
    previewLimit: 500,
    rows: [],
    messages: [],
    totalRows: 0,
    validRows: 0,
    warningRows: 0,
    errorRows: 0,
    busy: false,
    jobId: "",
    jobStatus: "",
    jobStartedAt: "",
    jobFinishedAt: "",
    createdCount: 0,
    updatedCount: 0,
    processedErrorCount: 0
  };

  return Controller.extend("padones.santa.fe.controller.App", {
    onInit: function () {
      this._jobPollTimer = null;
      this.getView().setModel(new JSONModel({ ...INITIAL_STATE }), "app");

      const sLastJobId = window.localStorage.getItem("padonesSantaFeLastJobId");

      if (sLastJobId) {
        this.getView().getModel("app").setProperty("/jobId", sLastJobId);
        this._setMessages([{
          type: "Information",
          text: "Consultando estado del ultimo job..."
        }]);

        this._pollJobStatus(sLastJobId);
      }
    },

    onExit: function () {
      this._stopJobPolling();
    },

    onFileChange: function (oEvent) {
      const aFiles = oEvent.getParameter("files");
      const oFile = aFiles && aFiles[0];

      if (!oFile) {
        return;
      }

      if (!/\.(txt|csv)$/i.test(oFile.name)) {
        MessageBox.error("El archivo debe ser TXT o CSV.");
        this.byId("fileUploader").clear();
        return;
      }

      const oReader = new FileReader();

      oReader.onload = function (oLoadEvent) {
        const sContent = oLoadEvent.target.result || "";
        const oModel = this.getView().getModel("app");

        this._stopJobPolling();

        oModel.setData({ ...INITIAL_STATE });
        oModel.setProperty("/fileName", oFile.name);
        oModel.setProperty("/fileContent", sContent);

        this._parseContent();
      }.bind(this);

      oReader.onerror = function () {
        MessageBox.error("No se pudo leer el archivo seleccionado.");
      };

      oReader.readAsText(oFile, "UTF-8");
    },

    onReparse: function () {
      const sContent = this.getView().getModel("app").getProperty("/fileContent");

      if (sContent) {
        this._parseContent();
      }
    },

    onPrepareUpload: async function () {
      const oModel = this.getView().getModel("app");
      const aRows = oModel.getProperty("/rows") || [];
      const sFileName = oModel.getProperty("/fileName");
      const iTotalRows = oModel.getProperty("/totalRows");

      if (!aRows.length) {
        MessageBox.warning("No hay registros validos para procesar.");
        return;
      }

      MessageBox.confirm(
        "Se van a enviar " + aRows.length + " registros filtrados para procesarlos en segundo plano. Podras cerrar la pestana y el job seguira corriendo. Continuar?",
        {
          onClose: async function (sAction) {
            if (sAction !== MessageBox.Action.OK) {
              return;
            }

            await this._startBackgroundJob(sFileName, iTotalRows, aRows);
          }.bind(this)
        }
      );
    },

    onClear: function () {
      this._stopJobPolling();
      window.localStorage.removeItem("padonesSantaFeLastJobId");
      this.getView().getModel("app").setData({ ...INITIAL_STATE });
      this.byId("fileUploader").clear();
      MessageToast.show("Carga limpiada");
    },

    _parseContent: async function () {
      const oModel = this.getView().getModel("app");
      const sContent = oModel.getProperty("/fileContent") || "";
      const aRawLines = sContent.split(/\r?\n/).filter(function (sLine) {
        return sLine.trim().length > 0;
      });
      const aParsedRows = [];
      const aMessages = [];
      let iInitialValidRows = 0;
      let iWarningRows = 0;
      let iErrorRows = 0;

      oModel.setProperty("/busy", true);
      oModel.setProperty("/rows", []);
      this._setMessages([{
        type: "Information",
        text: "Archivo leído. Validando " + aRawLines.length + " líneas del padrón."
      }, {
        type: "Information",
        text: "Consultando Business Partners en S/4HANA para filtrar CUITs existentes."
      }]);

      aRawLines.forEach(function (sLine, iIndex) {
        const iLineNumber = iIndex + 1;
        const aColumns = this._splitLine(sLine);
        const oRow = this._mapColumns(aColumns, iLineNumber);

        if (oRow.statusState === "Success") {
          iInitialValidRows += 1;
        } else if (oRow.statusState === "Warning") {
          iWarningRows += 1;
        } else {
          iErrorRows += 1;

          if (aMessages.length < 100) {
            aMessages.push({
              type: "Error",
              text: "Linea " + iLineNumber + ": " + oRow.statusText
            });
          }
        }

        aParsedRows.push(oRow);
      }.bind(this));

      if (!aRawLines.length) {
        aMessages.push({
          type: "Warning",
          text: "El archivo no contiene lineas de datos para procesar."
        });
      }

      try {
        const oBpByCuit = await this._loadBusinessPartnerIndex();

        const aValidRowsInClient = aParsedRows.filter(function (oRow) {
          const oBpData = oBpByCuit.get(this._normalizeCuit(oRow.cuit));

          if (oRow.statusState !== "Success" || !oBpData || !oBpData.customer) {
            return false;
          }

          oRow.businessPartner = oBpData.businessPartner;
          oRow.customer = oBpData.customer;
          return true;
        }.bind(this));

        const iRemovedRows = iInitialValidRows - aValidRowsInClient.length;

        if (iRemovedRows > 0) {
          aMessages.unshift({
            type: "Information",
            text: "Se eliminaron " + iRemovedRows + " registros porque su CUIT no existe como Business Partner del cliente."
          });
        }

        aMessages.unshift({
          type: "Information",
          text: "Archivo filtrado correctamente. Registros listos para procesar: " + aValidRowsInClient.length + "."
        });

        oModel.setProperty("/rows", aValidRowsInClient);
        this._addMessages(aMessages);
        oModel.setProperty("/totalRows", aRawLines.length);
        oModel.setProperty("/validRows", aValidRowsInClient.length);
        oModel.setProperty("/warningRows", iWarningRows);
        oModel.setProperty("/errorRows", iErrorRows);
      } catch (oError) {
        const sErrorDetail = oError && oError.message ? oError.message : String(oError || "");

        console.error("No se pudieron recuperar los Business Partners.", oError);

        oModel.setProperty("/rows", []);
        this._addMessage({
          type: "Error",
          text: "No se pudieron recuperar los Business Partners desde API_BUSINESS_PARTNER. " + sErrorDetail
        });
        oModel.setProperty("/totalRows", aRawLines.length);
        oModel.setProperty("/validRows", 0);
        oModel.setProperty("/warningRows", iWarningRows);
        oModel.setProperty("/errorRows", iErrorRows);

        MessageBox.error("No se pudieron recuperar los Business Partners desde API_BUSINESS_PARTNER.\n\nDetalle: " + sErrorDetail);
      } finally {
        oModel.setProperty("/busy", false);
      }
    },

    _loadBusinessPartnerIndex: async function () {
      const oBpByCuit = new Map();
      const oCustomerByBp = new Map();

      let sTaxUrl = "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartnerTaxNumber?$select=BusinessPartner,BPTaxNumber,BPTaxLongNumber&$format=json";

      while (sTaxUrl) {
        const oResponse = await fetch(sTaxUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar A_BusinessPartnerTaxNumber: " + await oResponse.text());
        }

        const oData = await oResponse.json();
        const aResults = oData && oData.d && oData.d.results ? oData.d.results : [];

        aResults.forEach(function (oItem) {
          [oItem.BPTaxNumber, oItem.BPTaxLongNumber].forEach(function (sValue) {
            const sCuit = this._normalizeCuit(sValue);

            if (sCuit.length === 11) {
              oBpByCuit.set(sCuit, {
                businessPartner: oItem.BusinessPartner,
                customer: ""
              });
            }
          }.bind(this));
        }.bind(this));

        sTaxUrl = oData && oData.d && oData.d.__next
          ? oData.d.__next.replace(/^https?:\/\/[^/]+/, "")
          : "";
      }

      let sBpUrl = "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_BusinessPartner?$select=BusinessPartner,Customer&$format=json";

      while (sBpUrl) {
        const oResponse = await fetch(sBpUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar A_BusinessPartner: " + await oResponse.text());
        }

        const oData = await oResponse.json();
        const aResults = oData && oData.d && oData.d.results ? oData.d.results : [];

        aResults.forEach(function (oItem) {
          if (oItem.Customer) {
            oCustomerByBp.set(oItem.BusinessPartner, oItem.Customer);
          }
        });

        sBpUrl = oData && oData.d && oData.d.__next
          ? oData.d.__next.replace(/^https?:\/\/[^/]+/, "")
          : "";
      }

      oBpByCuit.forEach(function (oValue) {
        oValue.customer = oCustomerByBp.get(oValue.businessPartner) || "";
      });

      return oBpByCuit;
    },

    _startBackgroundJob: async function (sFileName, iTotalRows, aRows) {
      const oModel = this.getView().getModel("app");

      this._stopJobPolling();

      oModel.setProperty("/busy", true);
      oModel.setProperty("/createdCount", 0);
      oModel.setProperty("/updatedCount", 0);
      oModel.setProperty("/processedErrorCount", 0);
      this._addMessage({
        type: "Information",
        text: "Enviando " + aRows.length + " registros al backend para procesamiento."
      });

      try {
        const oResponse = await fetch("/api/jobs", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            fileName: sFileName,
            totalRows: iTotalRows,
            rows: aRows
          })
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al crear job: " + await oResponse.text());
        }

        const oJob = await oResponse.json();

        oModel.setProperty("/jobId", oJob.id);
        oModel.setProperty("/jobStatus", oJob.status);
        window.localStorage.setItem("padonesSantaFeLastJobId", oJob.id);
        oModel.setProperty("/jobStartedAt", oJob.startedAt || "");
        this._addMessage({
          type: "Information",
          text: "Job en proceso. ID: " + oJob.id + ". Inicio: " + this._formatDateTime(oJob.startedAt)
        });

        this._startJobPolling(oJob.id);
      } catch (oError) {
        oModel.setProperty("/busy", false);
        this._addMessage({
          type: "Error",
          text: "No se pudo iniciar el job. " + (oError.message || oError)
        });
        MessageBox.error("No se pudo iniciar el job de procesamiento.");
      }
    },

    _startJobPolling: function (sJobId) {
      this._pollJobStatus(sJobId);

      this._jobPollTimer = setInterval(function () {
        this._pollJobStatus(sJobId);
      }.bind(this), 5000);
    },

    _stopJobPolling: function () {
      if (this._jobPollTimer) {
        clearInterval(this._jobPollTimer);
        this._jobPollTimer = null;
      }
    },

    _pollJobStatus: async function (sJobId) {
      const oModel = this.getView().getModel("app");

      try {
        const oResponse = await fetch("/api/jobs/" + encodeURIComponent(sJobId), {
          method: "GET",
          headers: {
            "Accept": "application/json"
          }
        });

        if (!oResponse.ok) {
          throw new Error("HTTP " + oResponse.status + " al consultar job: " + await oResponse.text());
        }

        const oJob = await oResponse.json();
        const bFinished = this._isTerminalJobStatus(oJob.status);

        oModel.setProperty("/jobStatus", oJob.status || "");
        oModel.setProperty("/jobStartedAt", oJob.startedAt || "");
        oModel.setProperty("/jobFinishedAt", oJob.finishedAt || "");
        oModel.setProperty("/totalRows", oJob.totalRows || oModel.getProperty("/totalRows") || 0);
        oModel.setProperty("/validRows", oJob.validRows || oModel.getProperty("/validRows") || 0);
        oModel.setProperty("/errorRows", oJob.errorCount || 0);
        oModel.setProperty("/createdCount", oJob.createdCount || 0);
        oModel.setProperty("/updatedCount", oJob.updatedCount || 0);
        oModel.setProperty("/processedErrorCount", oJob.errorCount || 0);
        this._addMessage(this._buildJobMessage(oJob), true);

        if (bFinished) {
          this._stopJobPolling();
          oModel.setProperty("/busy", false);

          if (oJob.status === "FINALIZADO") {
            MessageBox.success(oJob.message || "Job finalizado correctamente.");
          } else if (oJob.status === "FINALIZADO_CON_ERRORES") {
            MessageBox.warning(oJob.message || "Job finalizado con errores.");
          } else {
            MessageBox.error(oJob.message || "El job finalizo con error.");
          }
        }
      } catch (oError) {
        this._stopJobPolling();
        oModel.setProperty("/busy", false);
        this._addMessage({
          type: "Error",
          text: "No se pudo consultar el estado del job. " + (oError.message || oError)
        });
      }
    },

    _isTerminalJobStatus: function (sStatus) {
      return sStatus === "FINALIZADO" ||
        sStatus === "FINALIZADO_CON_ERRORES" ||
        sStatus === "ERROR";
    },

    _buildJobMessage: function (oJob) {
      const sStatus = oJob.status || "";
      const sStartedAt = this._formatDateTime(oJob.startedAt);
      const sFinishedAt = this._formatDateTime(oJob.finishedAt);
      const sMessage = oJob.message || "";

      if (sStatus === "EN_PROCESO") {
        return {
          type: "Information",
          text: "Job en proceso. Inicio: " + sStartedAt
        };
      }

      if (sStatus === "FINALIZADO") {
        return {
          type: "Success",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      if (sStatus === "FINALIZADO_CON_ERRORES") {
        return {
          type: "Warning",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      if (sStatus === "ERROR") {
        return {
          type: "Error",
          text: sMessage + " Inicio: " + sStartedAt + ". Fin: " + sFinishedAt
        };
      }

      return {
        type: "Information",
        text: "Estado del job: " + sStatus
      };
    },

    _setMessages: function (aMessages) {
      this.getView().getModel("app").setProperty("/messages", this._normalizeMessages(aMessages));
    },

    _addMessages: function (aMessages) {
      aMessages.forEach(function (oMessage) {
        this._addMessage(oMessage);
      }.bind(this));
    },

    _addMessage: function (oMessage, bSkipDuplicate) {
      const oModel = this.getView().getModel("app");
      const aMessages = oModel.getProperty("/messages") || [];
      const oNormalizedMessage = this._normalizeMessages([oMessage])[0];
      const oLastMessage = aMessages[aMessages.length - 1];

      if (bSkipDuplicate && oLastMessage && oLastMessage.text === oNormalizedMessage.text && oLastMessage.type === oNormalizedMessage.type) {
        return;
      }

      aMessages.push(oNormalizedMessage);
      oModel.setProperty("/messages", aMessages.slice(-150));
    },

    _normalizeMessages: function (aMessages) {
      return (aMessages || []).map(function (oMessage) {
        return {
          type: oMessage.type || "Information",
          text: oMessage.text || "",
          timestamp: oMessage.timestamp || this._formatDateTime(new Date().toISOString())
        };
      }.bind(this));
    },

    formatDateTime: function (sValue) {
      return this._formatDateTime(sValue);
    },

    _formatDateTime: function (sValue) {
      if (!sValue) {
        return "-";
      }

      const oDate = new Date(sValue);

      if (isNaN(oDate.getTime())) {
        return sValue;
      }

      return oDate.toLocaleString("es-AR");
    },

    _splitLine: function (sLine) {
      return sLine.split(";").map(function (sValue) {
        return sValue.trim().replace(/^"|"$/g, "");
      });
    },

    _mapColumns: function (aColumns, iLineNumber) {
      const sTaxpayerType = (aColumns[4] || "").trim().toUpperCase();
      const sOriginalRate = aColumns[8] || "";
      const sSapRate = this._calculateSapRate(sTaxpayerType, sOriginalRate);
      const oRow = {
        line: iLineNumber,
        validFrom: this._formatSourceDate(aColumns[1] || ""),
        validTo: this._formatSourceDate(aColumns[2] || ""),
        cuit: this._formatCuit(aColumns[3] || ""),
        taxpayerType: sTaxpayerType,
        originalRate: sOriginalRate,
        rate: sSapRate,
        companyName: (aColumns[11] || "").trim(),
        customer: "",
        businessPartner: ""
      };
      const aErrors = [];

      if (!this._isValidCuit(oRow.cuit)) {
        aErrors.push("CUIT invalido o faltante");
      }

      if (!["C", "D"].includes(oRow.taxpayerType)) {
        aErrors.push("tipo de contribuyente invalido");
      }

      if (!this._isValidRate(oRow.originalRate)) {
        aErrors.push("alicuota de percepcion invalida");
      }

      if (!this._isValidSourceDate(aColumns[1]) || !this._isValidSourceDate(aColumns[2])) {
        aErrors.push("vigencia invalida");
      }

      if (aColumns.length < 12) {
        aErrors.push("faltan columnas del formato Santa Fe PARP");
      }

      if (aErrors.length) {
        oRow.statusState = "Error";
        oRow.statusText = aErrors.join(", ");
      } else {
        oRow.statusState = "Success";
        oRow.statusText = "Listo";
      }

      return oRow;
    },

    _isValidCuit: function (sValue) {
      return /^\d{2}-?\d{8}-?\d$/.test((sValue || "").trim());
    },

    _isValidRate: function (sValue) {
      const sNormalized = this._normalizeRate(sValue);
      const fRate = Number(sNormalized);

      return Number.isFinite(fRate) && fRate >= 0 && fRate <= 100;
    },

    _isValidSourceDate: function (sValue) {
      return /^\d{7,8}$/.test((sValue || "").trim());
    },

    _formatSourceDate: function (sValue) {
      const sDate = (sValue || "").trim().padStart(8, "0");

      if (!this._isValidSourceDate(sDate)) {
        return (sValue || "").trim();
      }

      return sDate.slice(0, 2) + "." + sDate.slice(2, 4) + "." + sDate.slice(4, 8);
    },

    _formatCuit: function (sValue) {
      const sCuit = this._normalizeCuit(sValue);

      if (sCuit.length !== 11) {
        return sValue;
      }

      return sCuit.slice(0, 2) + "-" + sCuit.slice(2, 10) + "-" + sCuit.slice(10);
    },

    _normalizeCuit: function (sValue) {
      return (sValue || "").replace(/\D/g, "");
    },

    _normalizeRate: function (sValue) {
      return String(sValue || "").replace("%", "").replace(",", ".").trim();
    },

    _calculateSapRate: function (sTaxpayerType, sOriginalRate) {
      const fOriginalRate = Number(this._normalizeRate(sOriginalRate));

      if (!Number.isFinite(fOriginalRate)) {
        return sOriginalRate;
      }

      const fSapRate = sTaxpayerType === "C" ? fOriginalRate / 2 : fOriginalRate;

      return String(fSapRate).replace(".", ",");
    }
  });
});
