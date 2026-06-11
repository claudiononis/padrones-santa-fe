# Padrón Santa Fe - Percepciones IIBB

Aplicación UI5 + Node.js + PostgreSQL para cargar el padrón Santa Fe PARP de percepciones IIBB, validar contribuyentes contra Business Partner en S/4HANA y crear/actualizar condition records de percepción.

## Alcance

- Selección de archivo TXT o CSV separado por punto y coma.
- Lectura del formato Santa Fe PARP sin cabecera.
- Mapeo de vigencia desde, vigencia hasta, CUIT, tipo de contribuyente, alícuota de percepción y razón social.
- Cálculo de alícuota SAP:
  - Tipo `C`: alícuota de percepción / 2.
  - Tipo `D`: alícuota de percepción.
- Validación básica de CUIT, tipo, alícuota y fechas.
- Filtrado por CUIT existente como Business Partner con cliente asociado.
- Visualización de CUIT, tipo, alícuota original, alícuota SAP y razón social.
- Procesamiento en segundo plano con estado persistido en PostgreSQL.

## Formato Santa Fe PARP confirmado

El archivo `padron santa fe/PARP_202605(in).csv` contiene 12 columnas separadas por `;`, sin fila de encabezado. Ejemplo:

```txt
21042026;1052026;31052026;20060166847;D;-;N;2,5;1,5;0;0;ENRIQUE COSTANTE BERTUCCELLI
```

La aplicación usa estas posiciones:

```text
Campo 2: Fecha Vigencia Desde
Campo 3: Fecha Vigencia Hasta
Campo 4: CUIT
Campo 5: Tipo-Contr_Insc
Campo 9: Alicuota Percepcion
Campo 12: Razon Social
```

Las fechas se aceptan con 7 u 8 dígitos para contemplar valores como `1052026`, interpretado como `01.05.2026`.

## Ejecutar localmente

```powershell
npm install
npm start
```

En SAP Business Application Studio, para probar también el flujo de backend local, abrir dos terminales:

```bash
npm run start-api-local
npm start
```

El backend local usa `LOCAL_DEV_MODE=true`, guarda jobs en memoria y simula el procesamiento SAP. En Cloud Foundry se usan PostgreSQL y Destination Service reales.

## Build MTA

```powershell
npm install
npm run build
mbt build
```

## Despliegue en Cloud Foundry

```powershell
cf login
cf deploy mta_archives/padones-santa-fe_0.1.0.mtar
```

## Recursos requeridos en BTP

- `html5-apps-repo` host y runtime.
- `xsuaa`.
- `destination`.
- PostgreSQL existente `padrones-tax-upload-postgres`.
- Destinations hacia S/4HANA:
  - `S4HANA-BP` para `API_BUSINESS_PARTNER`.
  - `S4HANA-PRICING` para `API_SLSPRICINGCONDITIONRECORD_SRV`.

## PostgreSQL

El backend crea automáticamente la tabla `padrones_jobs` si no existe. No requiere cambios de esquema para el formato Santa Fe PARP porque las filas procesadas viajan en el payload del job y los contadores existentes siguen siendo suficientes.

En Cloud Foundry, el MTA reutiliza la instancia existente `padrones-tax-upload-postgres` mediante `org.cloudfoundry.existing-service` para evitar consumir un entitlement adicional de `postgresql-db/free`.
