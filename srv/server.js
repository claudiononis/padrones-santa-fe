const express = require("express");
const { Pool } = require("pg");
const { v4: uuidv4 } = require("uuid");

const app = express();
const port = process.env.PORT || 8080;

const PRICING_CONFIG = {
  conditionTable: "901",
  conditionType: "Z901",
  country: "AR",
  rateUnit: "%",
  taxCode: "SD"
};

const BP_TAX_CONFIG = {
  customerTaxGroupingCode: "IB1",
  subjectedEndDate: "9999-12-31T00:00:00"
};

const HTTP_TIMEOUT_MS = 60000;
const JOB_PROGRESS_UPDATE_EVERY = 1;
const LOCAL_DEV_MODE = process.env.LOCAL_DEV_MODE === "true";

app.use(express.json({ limit: "100mb" }));

function getBoundServiceByLabel(label, fallbackName) {
  const vcap = JSON.parse(process.env.VCAP_SERVICES || "{}");
  const services = Object.values(vcap).flat();

  return services.find(function (service) {
    return service.label === label || service.name === fallbackName;
  });
}

function getPostgresCredentials() {
  const postgres = getBoundServiceByLabel("postgresql-db", "padones-santa-fe-postgres");

  if (!postgres || !postgres.credentials) {
    throw new Error("No se encontraron credenciales de PostgreSQL en VCAP_SERVICES.");
  }

  return postgres.credentials;
}

function getDestinationCredentials() {
  const destination = getBoundServiceByLabel("destination", "padones-santa-fe-destination");

  if (!destination || !destination.credentials) {
    throw new Error("No se encontraron credenciales de Destination Service en VCAP_SERVICES.");
  }

  return destination.credentials;
}

function createPool() {
  const credentials = getPostgresCredentials();

  return new Pool({
    host: credentials.hostname,
    port: Number(credentials.port),
    database: credentials.dbname,
    user: credentials.username,
    password: credentials.password,
    ssl: {
      rejectUnauthorized: false
    }
  });
}

function createLocalPool() {
  const jobs = new Map();

  return {
    query: async function (sql, params) {
      const normalizedSql = String(sql || "").replace(/\s+/g, " ").trim().toLowerCase();

      if (normalizedSql.indexOf("create table") === 0) {
        return { rows: [] };
      }

      if (normalizedSql === "select 1") {
        return { rows: [{ "?column?": 1 }] };
      }

      if (normalizedSql.indexOf("insert into padrones_jobs") === 0) {
        jobs.set(params[0], {
          id: params[0],
          fileName: params[1],
          status: params[2],
          startedAt: params[3],
          finishedAt: null,
          totalRows: params[4],
          validRows: params[5],
          createdCount: 0,
          updatedCount: 0,
          errorCount: 0,
          message: params[6]
        });

        return { rows: [] };
      }

      if (normalizedSql.indexOf("update padrones_jobs set message") === 0) {
        const job = jobs.get(params[1]);

        if (job) {
          job.message = params[0];
        }

        return { rows: [] };
      }

      if (normalizedSql.indexOf("update padrones_jobs set status") === 0 && params.length === 9) {
        const job = jobs.get(params[8]);

        if (job) {
          job.status = params[0];
          job.finishedAt = params[1];
          job.totalRows = params[2];
          job.validRows = params[3];
          job.createdCount = params[4];
          job.updatedCount = params[5];
          job.errorCount = params[6];
          job.message = params[7];
        }

        return { rows: [] };
      }

      if (normalizedSql.indexOf("update padrones_jobs set status") === 0 && params.length === 5) {
        const job = jobs.get(params[4]);

        if (job) {
          job.status = params[0];
          job.finishedAt = params[1];
          job.errorCount = params[2];
          job.message = params[3];
        }

        return { rows: [] };
      }

      if (normalizedSql.indexOf("select id, file_name") === 0) {
        const job = jobs.get(params[0]);

        return { rows: job ? [job] : [] };
      }

      throw new Error("Consulta no soportada en modo local: " + normalizedSql);
    }
  };
}

const pool = LOCAL_DEV_MODE ? createLocalPool() : createPool();

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS padrones_jobs (
      id UUID PRIMARY KEY,
      file_name TEXT,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      total_rows INTEGER DEFAULT 0,
      valid_rows INTEGER DEFAULT 0,
      created_count INTEGER DEFAULT 0,
      updated_count INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      message TEXT,
      created_by TEXT
    )
  `);
}

function getDestinationToken() {
  const credentials = getDestinationCredentials();
  const tokenUrl = credentials.url + "/oauth/token";

  return fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(credentials.clientid + ":" + credentials.clientsecret).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: "grant_type=client_credentials"
  }).then(async function (response) {
    if (!response.ok) {
      throw new Error("HTTP " + response.status + " al obtener token de Destination Service: " + await response.text());
    }

    const data = await response.json();
    return data.access_token;
  });
}

async function getDestination(name) {
  const credentials = getDestinationCredentials();
  const token = await getDestinationToken();
  const url = credentials.uri + "/destination-configuration/v1/destinations/" + encodeURIComponent(name);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": "Bearer " + token,
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al leer destination " + name + ": " + await response.text());
  }

  return response.json();
}

async function callDestination(destinationName, path, options) {
  const destination = await getDestination(destinationName);
  const config = destination.destinationConfiguration || {};
  const targetUrl = (config.URL || config.Url || config.url || "").replace(/\/$/, "") + path;
  const headers = Object.assign({}, options && options.headers ? options.headers : {});
  const method = options && options.method ? options.method : "GET";
  const timeoutMs = options && options.timeoutMs ? options.timeoutMs : HTTP_TIMEOUT_MS;

  if (destination.authTokens && destination.authTokens.length) {
    headers.Authorization = destination.authTokens[0].type + " " + destination.authTokens[0].value;
  } else if (config.User && config.Password) {
    headers.Authorization = "Basic " + Buffer.from(config.User + ":" + config.Password).toString("base64");
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(targetUrl, {
      method: method,
      headers: headers,
      body: options && options.body ? options.body : undefined,
      signal: controller.signal
    });
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new Error("Timeout de " + timeoutMs + "ms llamando " + destinationName + " " + method + " " + path);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response, errorContext) {
  const text = await response.text();

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " " + errorContext + ": " + text);
  }

  return text ? JSON.parse(text) : {};
}

function getResponseCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }

  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function toCookieHeader(cookies) {
  return cookies.map(function (cookie) {
    return cookie.split(";")[0];
  }).join("; ");
}

async function fetchPricingCsrfToken() {
  const response = await callDestination("S4HANA-PRICING", "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/", {
    headers: {
      "X-CSRF-Token": "Fetch",
      "Accept": "application/json"
    }
  });

  const token = response.headers.get("x-csrf-token");
  const cookies = getResponseCookies(response);
  const cookieHeader = toCookieHeader(cookies);

  if (!response.ok || !token) {
    throw new Error("No se pudo obtener CSRF token para pricing: " + await response.text());
  }

  return {
    token: token,
    cookie: cookieHeader
  };
}

async function fetchBpCsrfToken() {
  const response = await callDestination("S4HANA-BP", "/sap/opu/odata/sap/API_BUSINESS_PARTNER/", {
    headers: {
      "X-CSRF-Token": "Fetch",
      "Accept": "application/json"
    }
  });

  const token = response.headers.get("x-csrf-token");
  const cookies = getResponseCookies(response);
  const cookieHeader = toCookieHeader(cookies);

  if (!response.ok || !token) {
    throw new Error("No se pudo obtener CSRF token para Business Partner: " + await response.text());
  }

  return {
    token: token,
    cookie: cookieHeader
  };
}

function escapeODataKey(value) {
  return String(value || "").replace(/'/g, "''");
}

function getCustomerTaxGroupingKeyPath(customer) {
  return "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_CustomerTaxGrouping(Customer='" +
    escapeODataKey(customer) +
    "',CustomerTaxGroupingCode='" +
    escapeODataKey(BP_TAX_CONFIG.customerTaxGroupingCode) +
    "')";
}

function getCustomerTaxGroupingNavigationPath(customer) {
  return "/sap/opu/odata/sap/API_BUSINESS_PARTNER/A_Customer('" +
    escapeODataKey(customer) +
    "')/to_CustomerTaxGrouping";
}

function toFiscalSubjectedStartDate(validFrom) {
  const parts = String(validFrom || "").split(".");

  if (parts.length === 3) {
    return parts[2] + "-" + parts[1] + "-01T00:00:00";
  }

  const isoMatch = String(validFrom || "").match(/^(\d{4})-(\d{2})-/);
  if (isoMatch) {
    return isoMatch[1] + "-" + isoMatch[2] + "-01T00:00:00";
  }

  return toODataDateTime(validFrom);
}

function isCustomerTaxGroupingAlreadyExistsError(errorText) {
  return String(errorText || "").indexOf("CVI_EI/015") !== -1 ||
    String(errorText || "").indexOf("already exists") !== -1 ||
    String(errorText || "").indexOf("ya existe") !== -1;
}

async function ensureCustomerTaxGrouping(row, bpCsrfToken) {
  const customer = row.customer;

  if (!customer) {
    throw new Error("No se pudo actualizar categoria fiscal: el registro no tiene Customer.");
  }

  const keyPath = getCustomerTaxGroupingKeyPath(customer) + "?$format=json";

  const readResponse = await callDestination("S4HANA-BP", keyPath, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (readResponse.ok) {
    return;
  }

  if (readResponse.status !== 404) {
    throw new Error("HTTP " + readResponse.status + " al consultar categoria fiscal IB1: " + await readResponse.text());
  }

  const payload = {
    CustomerTaxGroupingCode: BP_TAX_CONFIG.customerTaxGroupingCode,
    CustTaxGroupSubjectedStartDate: toFiscalSubjectedStartDate(row.validFrom),
    CustTaxGroupSubjectedEndDate: BP_TAX_CONFIG.subjectedEndDate
  };

  const createResponse = await callDestination("S4HANA-BP", getCustomerTaxGroupingNavigationPath(customer), {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": bpCsrfToken.token,
      "Cookie": bpCsrfToken.cookie
    },
    body: JSON.stringify(payload)
  });

  if (!createResponse.ok) {
    const errorText = await createResponse.text();

    if (isCustomerTaxGroupingAlreadyExistsError(errorText)) {
      return;
    }

    throw new Error("HTTP " + createResponse.status + " al crear categoria fiscal IB1: " + errorText);
  }
}

async function findPricingCondition(row) {
  const validFrom = toODataDateTime(row.validFrom);
  const validTo = toODataDateTime(row.validTo);

  const filter = [
    "ConditionType eq '" + PRICING_CONFIG.conditionType + "'",
    "Country eq '" + PRICING_CONFIG.country + "'",
    "Customer eq '" + row.customer + "'",
    "ConditionValidityStartDate eq datetime'" + validFrom + "'",
    "ConditionValidityEndDate eq datetime'" + validTo + "'"
  ].join(" and ");

  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgCndnRecdValidity" +
    "?$select=ConditionRecord,ConditionValidityStartDate,ConditionValidityEndDate" +
    "&$filter=" + encodeURIComponent(filter) +
    "&$format=json";

  const response = await callDestination("S4HANA-PRICING", path, {
    headers: { "Accept": "application/json" }
  });
  const data = await readJsonResponse(response, "al buscar condicion existente");
  const results = data && data.d && data.d.results ? data.d.results : [];

  return results[0] || null;
}

async function readPricingConditionRecord(conditionRecord) {
  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord('" +
    encodeURIComponent(conditionRecord) +
    "')?$format=json";

  const response = await callDestination("S4HANA-PRICING", path, {
    headers: { "Accept": "application/json" }
  });
  const data = await readJsonResponse(response, "al leer ETag de condicion");
  const etag = data && data.d && data.d.__metadata && data.d.__metadata.etag;

  if (!etag) {
    throw new Error("No se pudo obtener ETag de la condicion " + conditionRecord);
  }

  return etag;
}

async function createPricingCondition(row, csrfToken) {
  const payload = {
    ConditionTable: PRICING_CONFIG.conditionTable,
    ConditionType: PRICING_CONFIG.conditionType,
    ConditionRateValue: normalizeRate(row.rate),
    ConditionRateValueUnit: PRICING_CONFIG.rateUnit,
    ConditionTaxCode: PRICING_CONFIG.taxCode,
    to_SlsPrcgCndnRecdValidity: [
      {
        ConditionValidityStartDate: toODataDateTime(row.validFrom),
        ConditionValidityEndDate: toODataDateTime(row.validTo),
        ConditionType: PRICING_CONFIG.conditionType,
        Country: PRICING_CONFIG.country,
        Customer: row.customer
      }
    ]
  };

  const response = await callDestination("S4HANA-PRICING", "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken.token,
      "Cookie": csrfToken.cookie
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al crear condicion: " + await response.text());
  }
}

async function updatePricingCondition(conditionRecord, row, csrfToken) {
  const etag = await readPricingConditionRecord(conditionRecord);
  const payload = {
    ConditionRateValue: normalizeRate(row.rate),
    ConditionRateValueUnit: PRICING_CONFIG.rateUnit,
    ConditionTaxCode: PRICING_CONFIG.taxCode
  };

  const path = "/sap/opu/odata/sap/API_SLSPRICINGCONDITIONRECORD_SRV/A_SlsPrcgConditionRecord('" +
    encodeURIComponent(conditionRecord) +
    "')";

  const response = await callDestination("S4HANA-PRICING", path, {
    method: "PATCH",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken.token,
      "Cookie": csrfToken.cookie,
      "If-Match": etag
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " al actualizar condicion: " + await response.text());
  }
}

async function updateJobProgress(jobId, message) {
  await pool.query(
    `UPDATE padrones_jobs
     SET message = $1
     WHERE id = $2`,
    [message, jobId]
  );
}

async function processJob(jobId, jobData) {
  let created = 0;
  let updated = 0;
  let failed = 0;

  try {
    const validRows = Array.isArray(jobData.rows) ? jobData.rows : [];
    const totalRows = Number(jobData.totalRows || validRows.length);

    console.log("Job " + jobId + " iniciado. Registros validos: " + validRows.length);
    await updateJobProgress(jobId, "Job iniciado. Registros validos: " + validRows.length + ".");

    if (LOCAL_DEV_MODE) {
      await updateJobProgress(jobId, "Modo local: procesamiento backend simulado para " + validRows.length + " registros.");

      await pool.query(
        `UPDATE padrones_jobs
         SET status = $1,
             finished_at = $2,
             total_rows = $3,
             valid_rows = $4,
             created_count = $5,
             updated_count = $6,
             error_count = $7,
             message = $8
         WHERE id = $9`,
        [
          "FINALIZADO",
          new Date(),
          totalRows,
          validRows.length,
          validRows.length,
          0,
          0,
          "Modo local: job simulado correctamente. Registros recibidos: " + validRows.length + ".",
          jobId
        ]
      );

      return;
    }

    console.log("Job " + jobId + " obteniendo CSRF token BP");
    const bpCsrfToken = await fetchBpCsrfToken();

    console.log("Job " + jobId + " obteniendo CSRF token Pricing");
    const csrfToken = await fetchPricingCsrfToken();

    for (let index = 0; index < validRows.length; index += 1) {
      const row = validRows[index];
      const rowNumber = index + 1;
      const rowLabel = rowNumber + "/" + validRows.length + " customer " + row.customer + " CUIT " + row.cuit;

      try {
        console.log("Job " + jobId + " iniciando " + rowLabel);

        if (rowNumber % JOB_PROGRESS_UPDATE_EVERY === 0) {
          await updateJobProgress(jobId, "Procesando " + rowLabel + ".");
        }

        console.log("Job " + jobId + " verificando categoria fiscal IB1 para " + rowLabel);
        await ensureCustomerTaxGrouping(row, bpCsrfToken);
        console.log("Job " + jobId + " categoria fiscal IB1 OK para " + rowLabel);

        console.log("Job " + jobId + " buscando condicion existente para " + rowLabel);
        const existing = await findPricingCondition(row);
        console.log("Job " + jobId + " busqueda pricing OK para " + rowLabel + ". Existe: " + Boolean(existing));

        if (existing) {
          try {
            console.log("Job " + jobId + " actualizando condicion " + existing.ConditionRecord + " para " + rowLabel);
            await updatePricingCondition(existing.ConditionRecord, row, csrfToken);
            updated += 1;
            console.log("Job " + jobId + " condicion actualizada para " + rowLabel);
          } catch (updateError) {
            if (isMissingConditionRecordError(updateError)) {
              console.log("Job " + jobId + " condicion inexistente al actualizar. Creando nueva para " + rowLabel);
              await createPricingCondition(row, csrfToken);
              created += 1;
              console.log("Job " + jobId + " condicion creada para " + rowLabel);
            } else {
              throw updateError;
            }
          }
        } else {
          console.log("Job " + jobId + " creando condicion nueva para " + rowLabel);
          await createPricingCondition(row, csrfToken);
          created += 1;
          console.log("Job " + jobId + " condicion creada para " + rowLabel);
        }

        await updateJobProgress(
          jobId,
          "Procesado " + rowLabel + ". Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + "."
        );
      } catch (error) {
        failed += 1;

        console.error("Job " + jobId + " error procesando " + rowLabel, error);

        await updateJobProgress(
          jobId,
          "Error en " + rowLabel + ". Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + ". Ultimo error: " + (error.message || error)
        );
      }
    }

    console.log("Job " + jobId + " finalizado. Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + ".");

    await pool.query(
      `UPDATE padrones_jobs
       SET status = $1,
           finished_at = $2,
           total_rows = $3,
           valid_rows = $4,
           created_count = $5,
           updated_count = $6,
           error_count = $7,
           message = $8
       WHERE id = $9`,
      [
        failed ? "FINALIZADO_CON_ERRORES" : "FINALIZADO",
        new Date(),
        totalRows,
        validRows.length,
        created,
        updated,
        failed,
        "Proceso finalizado. Creadas: " + created + ". Actualizadas: " + updated + ". Errores: " + failed + ".",
        jobId
      ]
    );
  } catch (error) {
    console.error("Job " + jobId + " termino con error general", error);

    await pool.query(
      `UPDATE padrones_jobs
       SET status = $1,
           finished_at = $2,
           error_count = $3,
           message = $4
       WHERE id = $5`,
      ["ERROR", new Date(), 1, error.message || String(error), jobId]
    );
  }
}

function normalizeRate(value) {
  return String(value || "").replace("%", "").replace(",", ".").trim();
}

function toODataDateTime(value) {
  const parts = String(value || "").split(".");
  if (parts.length === 3) {
    return parts[2] + "-" + parts[1] + "-" + parts[0] + "T00:00:00";
  }
  return value + "T00:00:00";
}

function isMissingConditionRecordError(error) {
  const message = String(error && error.message ? error.message : error || "");
  return message.indexOf("PRCG_CNDNRECORD_API/023") !== -1 ||
    message.indexOf("no existe") !== -1;
}

app.get("/api/health", async function (req, res) {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "OK", database: "OK" });
  } catch (error) {
    res.status(500).json({ status: "ERROR", message: error.message });
  }
});

app.post("/api/jobs", async function (req, res) {
  const id = uuidv4();
  const startedAt = new Date();
  const fileName = req.body.fileName || "";
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const totalRows = Number(req.body.totalRows || rows.length);

  if (!rows.length) {
    res.status(400).json({ message: "No se recibieron registros filtrados para procesar." });
    return;
  }

  await pool.query(
    `INSERT INTO padrones_jobs
      (id, file_name, status, started_at, total_rows, valid_rows, message)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, fileName, "EN_PROCESO", startedAt, totalRows, rows.length, "Job en proceso."]
  );

  setImmediate(function () {
    processJob(id, {
      totalRows: totalRows,
      rows: rows
    });
  });

  res.status(202).json({
    id: id,
    status: "EN_PROCESO",
    startedAt: startedAt.toISOString()
  });
});

app.get("/api/jobs/:id", async function (req, res) {
  const result = await pool.query(
    `SELECT
      id,
      file_name AS "fileName",
      status,
      started_at AS "startedAt",
      finished_at AS "finishedAt",
      total_rows AS "totalRows",
      valid_rows AS "validRows",
      created_count AS "createdCount",
      updated_count AS "updatedCount",
      error_count AS "errorCount",
      message
     FROM padrones_jobs
     WHERE id = $1`,
    [req.params.id]
  );

  if (!result.rows.length) {
    res.status(404).json({ message: "Job no encontrado." });
    return;
  }

  res.json(result.rows[0]);
});

ensureSchema()
  .then(function () {
    app.listen(port, function () {
      console.log("padones-santa-fe-api listening on port " + port);
    });
  })
  .catch(function (error) {
    console.error("No se pudo inicializar el backend", error);
    process.exit(1);
  });
