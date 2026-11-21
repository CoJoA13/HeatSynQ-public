BEGIN;

-- Application schema from the reviewed disposable private-schema fixture.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;



COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';



CREATE TYPE public."AddressKind" AS ENUM (
    'SHIP_TO',
    'BILL_TO',
    'RECEIVED_FROM'
);



CREATE TYPE public."ApplicationType" AS ENUM (
    'PAYMENT',
    'DISCOUNT',
    'WRITE_OFF',
    'CREDIT'
);



CREATE TYPE public."CertScope" AS ENUM (
    'ORDER',
    'LOAD',
    'SHIPMENT'
);



CREATE TYPE public."DocumentKind" AS ENUM (
    'TRAVELER',
    'SHIPPER',
    'BOL',
    'CERT',
    'INVOICE',
    'CREDIT',
    'STATEMENT',
    'QUOTE'
);



CREATE TYPE public."FreightTerms" AS ENUM (
    'PREPAID',
    'COLLECT'
);



CREATE TYPE public."InvoiceKind" AS ENUM (
    'INVOICE',
    'CREDIT'
);



CREATE TYPE public."InvoiceLineKind" AS ENUM (
    'PART',
    'OPERATION',
    'SURCHARGE',
    'FREIGHT',
    'CHARGE',
    'CERT',
    'TAX'
);



CREATE TYPE public."InvoiceStatus" AS ENUM (
    'DRAFT',
    'FINALIZED'
);



CREATE TYPE public."OrderStatus" AS ENUM (
    'OPEN',
    'PARTIAL_SHIPPED',
    'SHIPPED',
    'INVOICED',
    'REOPENED'
);



CREATE TYPE public."OverrideMode" AS ENUM (
    'GRANT',
    'DENY'
);



CREATE TYPE public."PartFieldType" AS ENUM (
    'TEXT',
    'NUMBER',
    'DATE',
    'CHECKBOX'
);



CREATE TYPE public."PricePer" AS ENUM (
    'EACH',
    'LB',
    'PER_100',
    'PER_1000',
    'LOT'
);



CREATE TYPE public."PriceSource" AS ENUM (
    'PART_PRICE',
    'MANUAL',
    'QUOTE'
);



CREATE TYPE public."StepFieldType" AS ENUM (
    'NUMBER',
    'TEXT',
    'DATE',
    'CHECKBOX'
);



CREATE TYPE public."SurchargeKind" AS ENUM (
    'PERCENT',
    'FLAT'
);



CREATE TYPE public."SurchargeScope" AS ENUM (
    'ALL',
    'INCLUDE',
    'EXCLUDE'
);



CREATE TYPE public."TemplateDocType" AS ENUM (
    'TRAVELER',
    'SHIPPER',
    'MOS_SHIPPER',
    'BOL',
    'CERT',
    'INVOICE',
    'STATEMENT',
    'QUOTE',
    'CONTAINER_TAG'
);





CREATE TABLE public."Application" (
    id text NOT NULL,
    "invoiceId" text NOT NULL,
    amount numeric(12,2) NOT NULL,
    type public."ApplicationType" NOT NULL,
    reason text DEFAULT ''::text NOT NULL,
    "paymentId" text,
    "creditInvoiceId" text,
    "appliedDate" date NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "Application_source_check" CHECK ((((type = ANY (ARRAY['PAYMENT'::public."ApplicationType", 'DISCOUNT'::public."ApplicationType"])) AND ("paymentId" IS NOT NULL) AND ("creditInvoiceId" IS NULL)) OR ((type = 'WRITE_OFF'::public."ApplicationType") AND ("creditInvoiceId" IS NULL)) OR ((type = 'CREDIT'::public."ApplicationType") AND ("paymentId" IS NULL) AND ("creditInvoiceId" IS NOT NULL))))
);



CREATE TABLE public."AuditLog" (
    id text NOT NULL,
    at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "actorId" text,
    "actorName" text NOT NULL,
    entity text NOT NULL,
    "entityId" text NOT NULL,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    reason text
);



CREATE TABLE public."BillingConfig" (
    id text DEFAULT 'singleton'::text NOT NULL,
    "salesTaxRate" numeric(9,6),
    "salesTaxGlAccountId" text,
    "freightGlAccountId" text,
    "otherChargeGlAccountId" text,
    "certChargeStepCodeId" text,
    "certChargeDefault" numeric(12,2),
    "billForCertDefault" boolean DEFAULT false NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "financeChargeRate" numeric(6,4),
    "arGlAccountId" text,
    "discountGlAccountId" text,
    "writeOffGlAccountId" text,
    CONSTRAINT "BillingConfig_singleton_check" CHECK ((id = 'singleton'::text))
);



CREATE TABLE public."Carrier" (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."Cert" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    scope public."CertScope" NOT NULL,
    "loadNumber" integer,
    "shipperId" text,
    freeform text DEFAULT ''::text NOT NULL,
    "internalNotes" text DEFAULT ''::text NOT NULL,
    "printedAt" timestamp(3) without time zone,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."CertReading" (
    id text NOT NULL,
    "requirementId" text NOT NULL,
    "position" integer NOT NULL,
    value numeric(10,4),
    passed boolean,
    overridden boolean DEFAULT false NOT NULL,
    note text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."CertRequirement" (
    id text NOT NULL,
    "certId" text NOT NULL,
    "orderLineId" text,
    "position" integer NOT NULL,
    "inspectionCodeId" text NOT NULL,
    "scaleId" text,
    min numeric(10,4),
    max numeric(10,4),
    "sampleQty" text DEFAULT ''::text NOT NULL,
    location text DEFAULT ''::text NOT NULL,
    "linePosition" integer NOT NULL,
    "partNumber" text NOT NULL,
    "partName" text DEFAULT ''::text NOT NULL,
    "orderLineIdAtSeed" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."ClosePeriod" (
    id text NOT NULL,
    year integer NOT NULL,
    month integer NOT NULL,
    status text DEFAULT 'CLOSED'::text NOT NULL,
    "beginningAr" numeric(12,2) NOT NULL,
    "invoicedTotal" numeric(12,2) NOT NULL,
    "creditTotal" numeric(12,2) NOT NULL,
    "paymentTotal" numeric(12,2) NOT NULL,
    "discountTotal" numeric(12,2) NOT NULL,
    "writeOffTotal" numeric(12,2) NOT NULL,
    "endingAr" numeric(12,2) NOT NULL,
    "agingEndingAr" numeric(12,2) NOT NULL,
    "closedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "closedById" text,
    "reopenedAt" timestamp(3) without time zone,
    "reopenReason" text DEFAULT ''::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."CommentSnippet" (
    id text NOT NULL,
    name text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."ContainerType" (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "tareEach" numeric(12,2)
);



CREATE TABLE public."Customer" (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    "parentId" text,
    "termsId" text,
    "creditLimit" numeric(12,2),
    "creditHold" boolean DEFAULT false NOT NULL,
    cod boolean DEFAULT false NOT NULL,
    taxable boolean DEFAULT true NOT NULL,
    "defaultPo" text DEFAULT ''::text NOT NULL,
    "orderNotes" text DEFAULT ''::text NOT NULL,
    "shippingNotes" text DEFAULT ''::text NOT NULL,
    "invoiceNotes" text DEFAULT ''::text NOT NULL,
    "surchargeOptOut" boolean DEFAULT false NOT NULL,
    "financeChargeRate" numeric(6,4),
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "requestDaysOverride" integer,
    "certRequiredDefault" boolean,
    "certScopeDefault" public."CertScope",
    "certChargeSuppressed" boolean DEFAULT false NOT NULL,
    "salesTaxRate" numeric(9,6),
    phone text DEFAULT ''::text NOT NULL,
    "invoiceFolder" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."CustomerAddress" (
    id text NOT NULL,
    "customerId" text NOT NULL,
    kind public."AddressKind" NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    street text DEFAULT ''::text NOT NULL,
    city text DEFAULT ''::text NOT NULL,
    state text DEFAULT ''::text NOT NULL,
    zip text DEFAULT ''::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."CustomerContact" (
    id text NOT NULL,
    "customerId" text NOT NULL,
    name text NOT NULL,
    email text DEFAULT ''::text NOT NULL,
    phone text DEFAULT ''::text NOT NULL,
    "getsShippers" boolean DEFAULT false NOT NULL,
    "getsInvoices" boolean DEFAULT false NOT NULL,
    "getsStatements" boolean DEFAULT false NOT NULL,
    "getsCerts" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."CustomerSurcharge" (
    id text NOT NULL,
    "customerId" text NOT NULL,
    "surchargeId" text NOT NULL,
    "optOut" boolean DEFAULT false NOT NULL,
    rate numeric(9,6),
    amount numeric(12,2),
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."CustomerTemplateAssignment" (
    id text NOT NULL,
    "customerId" text NOT NULL,
    "docType" public."TemplateDocType" NOT NULL,
    "templateId" text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."DocumentTemplate" (
    id text NOT NULL,
    "docType" public."TemplateDocType" NOT NULL,
    name text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "publishedVersionId" text,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."DocumentTemplateVersion" (
    id text NOT NULL,
    "templateId" text NOT NULL,
    "versionNumber" integer NOT NULL,
    status text DEFAULT 'DRAFT'::text NOT NULL,
    config jsonb NOT NULL,
    "logoImage" bytea,
    "logoMimeType" text,
    "publishedAt" timestamp(3) without time zone,
    "publishedById" text,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."EndingStatement" (
    id text NOT NULL,
    name text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."GlAccount" (
    id text NOT NULL,
    name text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."GlExportBatch" (
    id text NOT NULL,
    "exportNumber" integer NOT NULL,
    "closePeriodId" text NOT NULL,
    "periodEnd" date NOT NULL,
    "emittedAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "emittedById" text,
    "fileName" text NOT NULL,
    "fileContentType" text DEFAULT 'text/csv'::text NOT NULL,
    file bytea NOT NULL,
    "registerContentType" text DEFAULT 'application/pdf'::text NOT NULL,
    register bytea NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."GlPosting" (
    id text NOT NULL,
    "batchId" text NOT NULL,
    "sourceType" text NOT NULL,
    "sourceId" text NOT NULL,
    "glDate" date NOT NULL,
    "glAccountId" text,
    "glAccountName" text DEFAULT ''::text NOT NULL,
    debit numeric(12,2) DEFAULT 0 NOT NULL,
    credit numeric(12,2) DEFAULT 0 NOT NULL,
    side text NOT NULL,
    memo text DEFAULT ''::text NOT NULL,
    "isReversal" boolean DEFAULT false NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);



CREATE TABLE public."InspectionCode" (
    id text NOT NULL,
    name text NOT NULL,
    "defaultScaleId" text,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."InspectionScale" (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."Invoice" (
    id text NOT NULL,
    kind public."InvoiceKind" DEFAULT 'INVOICE'::public."InvoiceKind" NOT NULL,
    "orderId" text NOT NULL,
    "sourceInvoiceId" text,
    "creditNumber" integer,
    "customerId" text NOT NULL,
    status public."InvoiceStatus" DEFAULT 'DRAFT'::public."InvoiceStatus" NOT NULL,
    "invoiceDate" date NOT NULL,
    "poNumber" text DEFAULT ''::text NOT NULL,
    "termsName" text DEFAULT ''::text NOT NULL,
    "billTo" text DEFAULT ''::text NOT NULL,
    "shipTo" text DEFAULT ''::text NOT NULL,
    "materialName" text DEFAULT ''::text NOT NULL,
    "processNames" text DEFAULT ''::text NOT NULL,
    "taxRate" numeric(9,6),
    subtotal numeric(12,2) DEFAULT 0 NOT NULL,
    "surchargeTotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "chargeTotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "certTotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "freightTotal" numeric(12,2) DEFAULT 0 NOT NULL,
    "taxTotal" numeric(12,2) DEFAULT 0 NOT NULL,
    total numeric(12,2) DEFAULT 0 NOT NULL,
    "finalizedAt" timestamp(3) without time zone,
    "finalizedById" text,
    "clientRequestId" text,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "dueDate" date,
    "financeChargeExempt" boolean DEFAULT false NOT NULL,
    "termsDiscountDays" integer,
    "termsDiscountPercent" numeric(5,2),
    "shipmentFingerprint" text,
    "removedLines" jsonb DEFAULT '[]'::jsonb NOT NULL
);



CREATE TABLE public."InvoiceLine" (
    id text NOT NULL,
    "invoiceId" text NOT NULL,
    "position" integer NOT NULL,
    kind public."InvoiceLineKind" NOT NULL,
    "parentLineId" text,
    "orderLineId" text,
    "processStepCodeId" text,
    "surchargeId" text,
    "orderChargeId" text,
    "glAccountId" text,
    "partNumber" text DEFAULT ''::text NOT NULL,
    "partName" text DEFAULT ''::text NOT NULL,
    "partDescription" text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "glAccountName" text DEFAULT ''::text NOT NULL,
    qty integer,
    weight numeric(12,2),
    "eachWeight" numeric(10,4),
    "pricePer" public."PricePer",
    "unitPrice" numeric(12,4),
    "setupCharge" numeric(12,2),
    "minimumCharge" numeric(12,2),
    "breakThreshold" numeric(12,2),
    "minimumApplied" boolean DEFAULT false NOT NULL,
    rate numeric(9,6),
    "priceSource" public."PriceSource",
    "needsPrice" boolean DEFAULT false NOT NULL,
    amount numeric(12,2) DEFAULT 0 NOT NULL,
    "sourceQuoteNumber" integer,
    "wordsChosen" boolean DEFAULT false NOT NULL
);



CREATE TABLE public."Load" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "loadNumber" integer NOT NULL,
    qty integer,
    weight numeric(12,2)
);



CREATE TABLE public."Material" (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."Order" (
    id text NOT NULL,
    "orderNumber" integer NOT NULL,
    "customerId" text NOT NULL,
    "poNumber" text DEFAULT ''::text NOT NULL,
    "vsOrderNumber" text DEFAULT ''::text NOT NULL,
    "receivedDate" date NOT NULL,
    "requestDate" date NOT NULL,
    "targetDate" date,
    status public."OrderStatus" DEFAULT 'OPEN'::public."OrderStatus" NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    "linkGroupId" text,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "clientRequestId" text,
    "certRequired" boolean DEFAULT false NOT NULL,
    "certScope" public."CertScope" DEFAULT 'ORDER'::public."CertScope" NOT NULL,
    "customerJobNo" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."OrderAttachment" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    filename text NOT NULL,
    "mimeType" text NOT NULL,
    size integer NOT NULL,
    "fileData" bytea NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."OrderCharge" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "position" integer NOT NULL,
    description text NOT NULL,
    amount numeric(12,2)
);



CREATE TABLE public."OrderContainer" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "position" integer NOT NULL,
    "typeId" text NOT NULL,
    count integer NOT NULL,
    pieces integer,
    "tareEach" numeric(12,2),
    "scaleGross" numeric(12,2),
    "customerContainerId" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."OrderDraft" (
    id text NOT NULL,
    "userId" text NOT NULL,
    payload jsonb,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."OrderLine" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "position" integer NOT NULL,
    "partId" text NOT NULL,
    "revisionNumber" integer,
    qty integer NOT NULL,
    weight numeric(12,2) NOT NULL,
    "quoteLineId" text
);



CREATE TABLE public."OrderSerial" (
    id text NOT NULL,
    "orderId" text NOT NULL,
    "lineId" text NOT NULL,
    "position" integer NOT NULL,
    serial text NOT NULL,
    description text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."Part" (
    id text NOT NULL,
    "customerId" text NOT NULL,
    "partNumber" text NOT NULL,
    name text DEFAULT ''::text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "materialId" text,
    "eachWeight" numeric(10,4) NOT NULL,
    "loadQty" integer,
    "loadWeight" numeric(10,2),
    "serializationRequired" boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "requestDaysOverride" integer,
    "certRequired" boolean,
    "certScope" public."CertScope",
    "billForCert" boolean,
    "certCharge" numeric(12,2),
    "processName" text DEFAULT ''::text NOT NULL,
    CONSTRAINT "Part_loadQty_check" CHECK ((("loadQty" IS NULL) OR ("loadQty" >= 1))),
    CONSTRAINT "Part_loadWeight_check" CHECK ((("loadWeight" IS NULL) OR ("loadWeight" > (0)::numeric)))
);



CREATE TABLE public."PartAttachment" (
    id text NOT NULL,
    "partId" text NOT NULL,
    filename text NOT NULL,
    "mimeType" text NOT NULL,
    size integer NOT NULL,
    "fileData" bytea NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."PartFieldDef" (
    id text NOT NULL,
    name text NOT NULL,
    type public."PartFieldType" NOT NULL,
    sort integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."PartFieldValue" (
    id text NOT NULL,
    "partId" text NOT NULL,
    "fieldId" text NOT NULL,
    value text DEFAULT ''::text NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."PartInspection" (
    id text NOT NULL,
    "partId" text NOT NULL,
    "inspectionCodeId" text NOT NULL,
    "scaleId" text,
    min numeric(10,4),
    max numeric(10,4),
    location text DEFAULT ''::text NOT NULL,
    sort integer NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "sampleQty" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."PartPrice" (
    id text NOT NULL,
    "partId" text NOT NULL,
    "processStepCodeId" text NOT NULL,
    "position" integer NOT NULL,
    "setupCharge" numeric(12,2),
    "unitPrice" numeric(12,4),
    "minimumCharge" numeric(12,2),
    "pricePer" public."PricePer" DEFAULT 'EACH'::public."PricePer" NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."PartPriceBreak" (
    id text NOT NULL,
    threshold numeric(12,2) NOT NULL,
    price numeric(12,4) NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "partPriceId" text NOT NULL
);



CREATE TABLE public."PartProcessRevision" (
    id text NOT NULL,
    "partId" text NOT NULL,
    "revisionNumber" integer NOT NULL,
    "lockedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "recipeId" text,
    "recipeSnapshot" jsonb
);



CREATE TABLE public."PartProcessStep" (
    id text NOT NULL,
    "revisionId" text NOT NULL,
    "position" integer NOT NULL,
    "codeId" text NOT NULL,
    instruction text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."PartProcessStepParameter" (
    id text NOT NULL,
    "stepId" text NOT NULL,
    "position" integer NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    type public."StepFieldType" NOT NULL,
    unit text,
    value text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."PartRecipe" (
    id text NOT NULL,
    "partId" text NOT NULL,
    number text NOT NULL,
    "numberKey" text NOT NULL,
    "usedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "PartRecipe_numberKey_check" CHECK (("numberKey" = upper(number))),
    CONSTRAINT "PartRecipe_number_check" CHECK (((number ~ '^[A-Za-z0-9-]{1,20}$'::text) AND (number = btrim(number))))
);



CREATE TABLE public."PartSpecification" (
    id text NOT NULL,
    "partId" text NOT NULL,
    "specificationId" text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."Payment" (
    id text NOT NULL,
    "batchId" text NOT NULL,
    "customerId" text NOT NULL,
    "paymentTypeId" text NOT NULL,
    amount numeric(12,2) NOT NULL,
    reference text DEFAULT ''::text NOT NULL,
    "receivedDate" date NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."PaymentType" (
    id text NOT NULL,
    name text NOT NULL,
    "glAccountId" text,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."ProcessStepCode" (
    id text NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    "glAccountId" text,
    "equipmentTag" text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "defaultInstruction" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."ProcessStepFieldDef" (
    id text NOT NULL,
    "codeId" text NOT NULL,
    label text NOT NULL,
    type public."StepFieldType" NOT NULL,
    unit text,
    sort integer NOT NULL,
    "deletedAt" timestamp(3) without time zone
);



CREATE TABLE public."Quote" (
    id text NOT NULL,
    "quoteNumber" integer NOT NULL,
    "customerId" text NOT NULL,
    "contactId" text,
    status text DEFAULT 'OPEN'::text NOT NULL,
    "closeReason" text DEFAULT ''::text NOT NULL,
    "closedAt" timestamp(3) without time zone,
    "closedById" text,
    "quoteDate" date NOT NULL,
    "effectiveDate" date NOT NULL,
    "expiryDate" date NOT NULL,
    "followUpDate" date,
    "rfqNumber" text DEFAULT ''::text NOT NULL,
    "quotedById" text NOT NULL,
    "endingStatementId" text,
    notes text DEFAULT ''::text NOT NULL,
    "internalNotes" text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."QuoteLine" (
    id text NOT NULL,
    "quoteId" text NOT NULL,
    "position" integer NOT NULL,
    "partId" text,
    "partNumberText" text DEFAULT ''::text NOT NULL,
    "partNameText" text DEFAULT ''::text NOT NULL,
    "partDescriptionText" text DEFAULT ''::text NOT NULL,
    "materialText" text DEFAULT ''::text NOT NULL,
    "eachWeight" numeric(10,4),
    "quotedQty" integer,
    "quotedUnlimited" boolean DEFAULT false NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "materialId" text
);



CREATE TABLE public."QuotePrice" (
    id text NOT NULL,
    "quoteLineId" text NOT NULL,
    "processStepCodeId" text NOT NULL,
    "position" integer NOT NULL,
    "setupCharge" numeric(12,2),
    "unitPrice" numeric(12,4),
    "minimumCharge" numeric(12,2),
    "pricePer" public."PricePer" DEFAULT 'EACH'::public."PricePer" NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."QuotePriceBreak" (
    id text NOT NULL,
    "quotePriceId" text NOT NULL,
    threshold numeric(12,2) NOT NULL,
    price numeric(12,4) NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."ReceiptBatch" (
    id text NOT NULL,
    "batchNumber" integer NOT NULL,
    "depositDate" date NOT NULL,
    "controlTotal" numeric(12,2),
    status text DEFAULT 'OPEN'::text NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."RecipeSnapshotField" (
    "revisionId" text NOT NULL,
    "fieldDefId" text NOT NULL
);



CREATE TABLE public."Role" (
    id text NOT NULL,
    name text NOT NULL,
    "deletedAt" timestamp(3) without time zone
);



CREATE TABLE public."RolePermission" (
    id text NOT NULL,
    "roleId" text NOT NULL,
    permission text NOT NULL
);



CREATE TABLE public."SavedView" (
    id text NOT NULL,
    "userId" text NOT NULL,
    name text NOT NULL,
    config jsonb NOT NULL,
    "isDefault" boolean DEFAULT false NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."Session" (
    id text NOT NULL,
    "tokenHash" text NOT NULL,
    "userId" text NOT NULL,
    "expiresAt" timestamp(3) without time zone NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);



CREATE TABLE public."Setting" (
    key text NOT NULL,
    value jsonb NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "updatedBy" text
);



CREATE TABLE public."SetupState" (
    id text DEFAULT 'singleton'::text NOT NULL,
    "numbersConfirmedAt" timestamp(3) without time zone,
    "checklistDismissedAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "SetupState_singleton_check" CHECK ((id = 'singleton'::text))
);



CREATE TABLE public."Shipper" (
    id text NOT NULL,
    "shipperNumber" integer NOT NULL,
    "bolNumber" integer,
    "clientRequestId" text,
    "customerId" text NOT NULL,
    "shipToAddressId" text,
    "shipDate" date NOT NULL,
    "carrierId" text,
    route text DEFAULT ''::text NOT NULL,
    comments text DEFAULT ''::text NOT NULL,
    "billFreight" boolean DEFAULT false NOT NULL,
    "freightAmount" numeric(12,2),
    "freightTerms" public."FreightTerms" DEFAULT 'PREPAID'::public."FreightTerms" NOT NULL,
    "freightClass" text DEFAULT ''::text NOT NULL,
    "freightDescription" text DEFAULT ''::text NOT NULL,
    "packageCount" integer,
    "proNumber" text DEFAULT ''::text NOT NULL,
    "scacCode" text DEFAULT ''::text NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "reversesShipperId" text,
    "reversalClearedLineIds" text[] DEFAULT ARRAY[]::text[] NOT NULL
);



CREATE TABLE public."ShipperContainer" (
    id text NOT NULL,
    "shipperOrderId" text NOT NULL,
    "orderContainerId" text,
    "position" integer NOT NULL,
    count integer NOT NULL,
    "typeName" text NOT NULL,
    "customerContainerId" text DEFAULT ''::text NOT NULL,
    "tareEach" numeric(12,2)
);



CREATE TABLE public."ShipperLine" (
    id text NOT NULL,
    "shipperOrderId" text NOT NULL,
    "orderLineId" text,
    "position" integer NOT NULL,
    qty integer NOT NULL,
    weight numeric(12,2) NOT NULL,
    "lineComplete" boolean DEFAULT false NOT NULL,
    "partNumber" text NOT NULL,
    "partName" text DEFAULT ''::text NOT NULL,
    "partDescription" text DEFAULT ''::text NOT NULL,
    "orderedQty" integer NOT NULL,
    "orderedWeight" numeric(12,2) NOT NULL
);



CREATE TABLE public."ShipperOrder" (
    id text NOT NULL,
    "shipperId" text NOT NULL,
    "orderId" text NOT NULL,
    sequence integer NOT NULL,
    "position" integer NOT NULL
);



CREATE TABLE public."ShipperSerial" (
    id text NOT NULL,
    "shipperOrderId" text NOT NULL,
    "orderSerialId" text,
    "printOnShipper" boolean DEFAULT true NOT NULL,
    serial text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    "orderLineIdAtSave" text DEFAULT ''::text NOT NULL
);



CREATE TABLE public."Specification" (
    id text NOT NULL,
    name text NOT NULL,
    text text DEFAULT ''::text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."StoredDocument" (
    id text NOT NULL,
    "orderId" text,
    kind public."DocumentKind" NOT NULL,
    "loadNumber" integer,
    "fileData" bytea NOT NULL,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "certId" text,
    "shipperId" text,
    "invoiceId" text,
    "customerId" text,
    "quoteId" text,
    "templateVersionId" text,
    "coveredOrderIds" text[] DEFAULT ARRAY[]::text[] NOT NULL,
    "travelerLoadNumbers" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
    "travelerPrintRecord" text,
    CONSTRAINT "StoredDocument_kind_owner_check" CHECK ((((kind = 'TRAVELER'::public."DocumentKind") AND ("orderId" IS NOT NULL) AND ("shipperId" IS NULL) AND ("certId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = 'SHIPPER'::public."DocumentKind") AND ("shipperId" IS NOT NULL) AND ("certId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = 'BOL'::public."DocumentKind") AND ("shipperId" IS NOT NULL) AND ("orderId" IS NULL) AND ("certId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = 'CERT'::public."DocumentKind") AND ("certId" IS NOT NULL) AND ("orderId" IS NULL) AND ("shipperId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = ANY (ARRAY['INVOICE'::public."DocumentKind", 'CREDIT'::public."DocumentKind"])) AND ("invoiceId" IS NOT NULL) AND ("orderId" IS NULL) AND ("shipperId" IS NULL) AND ("certId" IS NULL) AND ("customerId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = 'STATEMENT'::public."DocumentKind") AND ("customerId" IS NOT NULL) AND ("orderId" IS NULL) AND ("shipperId" IS NULL) AND ("certId" IS NULL) AND ("invoiceId" IS NULL) AND ("quoteId" IS NULL)) OR ((kind = 'QUOTE'::public."DocumentKind") AND ("quoteId" IS NOT NULL) AND ("orderId" IS NULL) AND ("shipperId" IS NULL) AND ("certId" IS NULL) AND ("invoiceId" IS NULL) AND ("customerId" IS NULL)))),
    CONSTRAINT "StoredDocument_traveler_selection_scope" CHECK (((cardinality("travelerLoadNumbers") = 0) OR ((kind = 'TRAVELER'::public."DocumentKind") AND ("loadNumber" IS NULL) AND ((cardinality("travelerLoadNumbers") >= 2) AND (cardinality("travelerLoadNumbers") <= 100)))))
);



CREATE TABLE public."Surcharge" (
    id text NOT NULL,
    name text NOT NULL,
    kind public."SurchargeKind" DEFAULT 'PERCENT'::public."SurchargeKind" NOT NULL,
    rate numeric(9,6),
    amount numeric(12,2),
    "minimumAmount" numeric(12,2),
    "glAccountId" text,
    scope public."SurchargeScope" DEFAULT 'ALL'::public."SurchargeScope" NOT NULL,
    "position" integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL
);



CREATE TABLE public."SurchargeStepCode" (
    id text NOT NULL,
    "surchargeId" text NOT NULL,
    "processStepCodeId" text NOT NULL
);



CREATE TABLE public."Terms" (
    id text NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "discountDays" integer,
    "discountPercent" numeric(5,2),
    "netDays" integer DEFAULT 30 NOT NULL,
    CONSTRAINT "Terms_discount_pair_check" CHECK ((("discountPercent" IS NULL) = ("discountDays" IS NULL)))
);



CREATE TABLE public."UpdateHold" (
    id text DEFAULT 'singleton'::text NOT NULL,
    held boolean DEFAULT false NOT NULL,
    "fromVersion" text,
    "heldById" text,
    "heldAt" timestamp(3) without time zone,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    CONSTRAINT "UpdateHold_singleton_check" CHECK ((id = 'singleton'::text))
);



CREATE TABLE public."User" (
    id text NOT NULL,
    username text NOT NULL,
    "passwordHash" text NOT NULL,
    "displayName" text NOT NULL,
    "roleId" text,
    "signatureImage" bytea,
    active boolean DEFAULT true NOT NULL,
    "deletedAt" timestamp(3) without time zone,
    "createdAt" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp(3) without time zone NOT NULL,
    "signatureMimeType" text,
    title text DEFAULT ''::text NOT NULL,
    "signatureUpdatedAt" timestamp(3) without time zone,
    "lastSeenVersion" text
);



CREATE TABLE public."UserPermissionOverride" (
    id text NOT NULL,
    "userId" text NOT NULL,
    permission text NOT NULL,
    mode public."OverrideMode" NOT NULL
);



ALTER TABLE ONLY public."Application"
    ADD CONSTRAINT "Application_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."AuditLog"
    ADD CONSTRAINT "AuditLog_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Carrier"
    ADD CONSTRAINT "Carrier_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CertReading"
    ADD CONSTRAINT "CertReading_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CertRequirement"
    ADD CONSTRAINT "CertRequirement_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Cert"
    ADD CONSTRAINT "Cert_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ClosePeriod"
    ADD CONSTRAINT "ClosePeriod_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CommentSnippet"
    ADD CONSTRAINT "CommentSnippet_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ContainerType"
    ADD CONSTRAINT "ContainerType_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CustomerAddress"
    ADD CONSTRAINT "CustomerAddress_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CustomerContact"
    ADD CONSTRAINT "CustomerContact_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CustomerSurcharge"
    ADD CONSTRAINT "CustomerSurcharge_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."CustomerTemplateAssignment"
    ADD CONSTRAINT "CustomerTemplateAssignment_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Customer"
    ADD CONSTRAINT "Customer_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."DocumentTemplateVersion"
    ADD CONSTRAINT "DocumentTemplateVersion_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."DocumentTemplate"
    ADD CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."EndingStatement"
    ADD CONSTRAINT "EndingStatement_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."GlAccount"
    ADD CONSTRAINT "GlAccount_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."GlExportBatch"
    ADD CONSTRAINT "GlExportBatch_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."GlPosting"
    ADD CONSTRAINT "GlPosting_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."InspectionCode"
    ADD CONSTRAINT "InspectionCode_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."InspectionScale"
    ADD CONSTRAINT "InspectionScale_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Invoice"
    ADD CONSTRAINT "Invoice_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Load"
    ADD CONSTRAINT "Load_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Material"
    ADD CONSTRAINT "Material_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderAttachment"
    ADD CONSTRAINT "OrderAttachment_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderCharge"
    ADD CONSTRAINT "OrderCharge_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderContainer"
    ADD CONSTRAINT "OrderContainer_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderDraft"
    ADD CONSTRAINT "OrderDraft_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."OrderSerial"
    ADD CONSTRAINT "OrderSerial_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartAttachment"
    ADD CONSTRAINT "PartAttachment_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartFieldDef"
    ADD CONSTRAINT "PartFieldDef_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartFieldValue"
    ADD CONSTRAINT "PartFieldValue_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartInspection"
    ADD CONSTRAINT "PartInspection_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartPriceBreak"
    ADD CONSTRAINT "PartPriceBreak_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartPrice"
    ADD CONSTRAINT "PartPrice_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartProcessRevision"
    ADD CONSTRAINT "PartProcessRevision_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartProcessStepParameter"
    ADD CONSTRAINT "PartProcessStepParameter_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartProcessStep"
    ADD CONSTRAINT "PartProcessStep_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartRecipe"
    ADD CONSTRAINT "PartRecipe_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PartSpecification"
    ADD CONSTRAINT "PartSpecification_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Part"
    ADD CONSTRAINT "Part_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."PaymentType"
    ADD CONSTRAINT "PaymentType_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Payment"
    ADD CONSTRAINT "Payment_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ProcessStepCode"
    ADD CONSTRAINT "ProcessStepCode_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ProcessStepFieldDef"
    ADD CONSTRAINT "ProcessStepFieldDef_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."QuoteLine"
    ADD CONSTRAINT "QuoteLine_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."QuotePriceBreak"
    ADD CONSTRAINT "QuotePriceBreak_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."QuotePrice"
    ADD CONSTRAINT "QuotePrice_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ReceiptBatch"
    ADD CONSTRAINT "ReceiptBatch_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."RecipeSnapshotField"
    ADD CONSTRAINT "RecipeSnapshotField_pkey" PRIMARY KEY ("revisionId", "fieldDefId");



ALTER TABLE ONLY public."RolePermission"
    ADD CONSTRAINT "RolePermission_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Role"
    ADD CONSTRAINT "Role_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."SavedView"
    ADD CONSTRAINT "SavedView_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Setting"
    ADD CONSTRAINT "Setting_pkey" PRIMARY KEY (key);



ALTER TABLE ONLY public."SetupState"
    ADD CONSTRAINT "SetupState_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ShipperContainer"
    ADD CONSTRAINT "ShipperContainer_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ShipperLine"
    ADD CONSTRAINT "ShipperLine_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ShipperOrder"
    ADD CONSTRAINT "ShipperOrder_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."ShipperSerial"
    ADD CONSTRAINT "ShipperSerial_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Shipper"
    ADD CONSTRAINT "Shipper_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Specification"
    ADD CONSTRAINT "Specification_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."SurchargeStepCode"
    ADD CONSTRAINT "SurchargeStepCode_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Surcharge"
    ADD CONSTRAINT "Surcharge_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."Terms"
    ADD CONSTRAINT "Terms_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."UpdateHold"
    ADD CONSTRAINT "UpdateHold_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."UserPermissionOverride"
    ADD CONSTRAINT "UserPermissionOverride_pkey" PRIMARY KEY (id);



ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_pkey" PRIMARY KEY (id);



CREATE INDEX "Application_creditInvoiceId_idx" ON public."Application" USING btree ("creditInvoiceId");



CREATE INDEX "Application_invoiceId_idx" ON public."Application" USING btree ("invoiceId");



CREATE INDEX "Application_paymentId_idx" ON public."Application" USING btree ("paymentId");



CREATE INDEX "AuditLog_at_idx" ON public."AuditLog" USING btree (at);



CREATE INDEX "AuditLog_entity_entityId_idx" ON public."AuditLog" USING btree (entity, "entityId");



CREATE UNIQUE INDEX "Carrier_name_key" ON public."Carrier" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "CertReading_requirementId_position_key" ON public."CertReading" USING btree ("requirementId", "position");



CREATE UNIQUE INDEX "CertRequirement_certId_position_key" ON public."CertRequirement" USING btree ("certId", "position");



CREATE INDEX "CertRequirement_inspectionCodeId_idx" ON public."CertRequirement" USING btree ("inspectionCodeId");



CREATE INDEX "CertRequirement_orderLineId_idx" ON public."CertRequirement" USING btree ("orderLineId");



CREATE INDEX "CertRequirement_scaleId_idx" ON public."CertRequirement" USING btree ("scaleId");



CREATE INDEX "Cert_orderId_idx" ON public."Cert" USING btree ("orderId");



CREATE INDEX "Cert_shipperId_idx" ON public."Cert" USING btree ("shipperId");



CREATE UNIQUE INDEX "ClosePeriod_year_month_key" ON public."ClosePeriod" USING btree (year, month);



CREATE UNIQUE INDEX "CommentSnippet_name_key" ON public."CommentSnippet" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "ContainerType_name_key" ON public."ContainerType" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "CustomerAddress_customerId_kind_idx" ON public."CustomerAddress" USING btree ("customerId", kind);



CREATE INDEX "CustomerContact_customerId_idx" ON public."CustomerContact" USING btree ("customerId");



CREATE UNIQUE INDEX "CustomerSurcharge_customerId_surchargeId_key" ON public."CustomerSurcharge" USING btree ("customerId", "surchargeId") WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "CustomerTemplateAssignment_customerId_docType_key" ON public."CustomerTemplateAssignment" USING btree ("customerId", "docType") WHERE ("deletedAt" IS NULL);



CREATE INDEX "CustomerTemplateAssignment_customerId_idx" ON public."CustomerTemplateAssignment" USING btree ("customerId");



CREATE INDEX "CustomerTemplateAssignment_templateId_idx" ON public."CustomerTemplateAssignment" USING btree ("templateId");



CREATE UNIQUE INDEX "Customer_code_key" ON public."Customer" USING btree (code) WHERE ("deletedAt" IS NULL);



CREATE INDEX "Customer_name_idx" ON public."Customer" USING btree (name);



CREATE UNIQUE INDEX "DocumentTemplateVersion_templateId_versionNumber_key" ON public."DocumentTemplateVersion" USING btree ("templateId", "versionNumber");



CREATE UNIQUE INDEX "DocumentTemplate_docType_name_key" ON public."DocumentTemplate" USING btree ("docType", name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "EndingStatement_name_key" ON public."EndingStatement" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "GlAccount_name_key" ON public."GlAccount" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "GlExportBatch_closePeriodId_idx" ON public."GlExportBatch" USING btree ("closePeriodId");



CREATE UNIQUE INDEX "GlExportBatch_exportNumber_key" ON public."GlExportBatch" USING btree ("exportNumber");



CREATE INDEX "GlPosting_batchId_idx" ON public."GlPosting" USING btree ("batchId");



CREATE INDEX "GlPosting_glAccountId_idx" ON public."GlPosting" USING btree ("glAccountId");



CREATE INDEX "GlPosting_glDate_idx" ON public."GlPosting" USING btree ("glDate");



CREATE INDEX "GlPosting_sourceType_sourceId_idx" ON public."GlPosting" USING btree ("sourceType", "sourceId");



CREATE UNIQUE INDEX "InspectionCode_name_key" ON public."InspectionCode" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "InspectionScale_name_key" ON public."InspectionScale" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "InvoiceLine_glAccountId_idx" ON public."InvoiceLine" USING btree ("glAccountId");



CREATE INDEX "InvoiceLine_invoiceId_idx" ON public."InvoiceLine" USING btree ("invoiceId");



CREATE UNIQUE INDEX "InvoiceLine_invoiceId_position_key" ON public."InvoiceLine" USING btree ("invoiceId", "position");



CREATE INDEX "InvoiceLine_orderLineId_idx" ON public."InvoiceLine" USING btree ("orderLineId");



CREATE INDEX "InvoiceLine_processStepCodeId_idx" ON public."InvoiceLine" USING btree ("processStepCodeId");



CREATE INDEX "InvoiceLine_surchargeId_idx" ON public."InvoiceLine" USING btree ("surchargeId");



CREATE UNIQUE INDEX "Invoice_clientRequestId_key" ON public."Invoice" USING btree ("clientRequestId");



CREATE UNIQUE INDEX "Invoice_creditNumber_key" ON public."Invoice" USING btree ("creditNumber");



CREATE INDEX "Invoice_customerId_idx" ON public."Invoice" USING btree ("customerId");



CREATE INDEX "Invoice_finalizedAt_idx" ON public."Invoice" USING btree ("finalizedAt");



CREATE INDEX "Invoice_invoiceDate_idx" ON public."Invoice" USING btree ("invoiceDate");



CREATE INDEX "Invoice_orderId_idx" ON public."Invoice" USING btree ("orderId");



CREATE UNIQUE INDEX "Invoice_orderId_key" ON public."Invoice" USING btree ("orderId") WHERE (("deletedAt" IS NULL) AND (kind = 'INVOICE'::public."InvoiceKind"));



CREATE INDEX "Invoice_status_idx" ON public."Invoice" USING btree (status);



CREATE UNIQUE INDEX "Load_orderId_loadNumber_key" ON public."Load" USING btree ("orderId", "loadNumber");



CREATE UNIQUE INDEX "Material_name_key" ON public."Material" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "OrderAttachment_orderId_idx" ON public."OrderAttachment" USING btree ("orderId");



CREATE UNIQUE INDEX "OrderCharge_orderId_position_key" ON public."OrderCharge" USING btree ("orderId", "position");



CREATE UNIQUE INDEX "OrderContainer_orderId_position_key" ON public."OrderContainer" USING btree ("orderId", "position");



CREATE INDEX "OrderContainer_typeId_idx" ON public."OrderContainer" USING btree ("typeId");



CREATE UNIQUE INDEX "OrderDraft_userId_key" ON public."OrderDraft" USING btree ("userId");



CREATE UNIQUE INDEX "OrderLine_orderId_position_key" ON public."OrderLine" USING btree ("orderId", "position");



CREATE INDEX "OrderLine_partId_idx" ON public."OrderLine" USING btree ("partId");



CREATE INDEX "OrderLine_quoteLineId_idx" ON public."OrderLine" USING btree ("quoteLineId");



CREATE UNIQUE INDEX "OrderSerial_lineId_position_key" ON public."OrderSerial" USING btree ("lineId", "position");



CREATE UNIQUE INDEX "OrderSerial_lineId_serial_key" ON public."OrderSerial" USING btree ("lineId", serial);



CREATE INDEX "OrderSerial_orderId_idx" ON public."OrderSerial" USING btree ("orderId");



CREATE INDEX "OrderSerial_serial_idx" ON public."OrderSerial" USING btree (serial);



CREATE INDEX "OrderSerial_serial_trgm_idx" ON public."OrderSerial" USING gin (serial public.gin_trgm_ops);



CREATE UNIQUE INDEX "Order_clientRequestId_key" ON public."Order" USING btree ("clientRequestId");



CREATE INDEX "Order_customerId_idx" ON public."Order" USING btree ("customerId");



CREATE INDEX "Order_linkGroupId_idx" ON public."Order" USING btree ("linkGroupId");



CREATE UNIQUE INDEX "Order_orderNumber_key" ON public."Order" USING btree ("orderNumber");



CREATE INDEX "Order_poNumber_idx" ON public."Order" USING btree ("poNumber");



CREATE INDEX "Order_receivedDate_idx" ON public."Order" USING btree ("receivedDate");



CREATE INDEX "Order_requestDate_idx" ON public."Order" USING btree ("requestDate");



CREATE INDEX "Order_status_idx" ON public."Order" USING btree (status);



CREATE INDEX "Order_vsOrderNumber_idx" ON public."Order" USING btree ("vsOrderNumber");



CREATE INDEX "PartAttachment_partId_idx" ON public."PartAttachment" USING btree ("partId");



CREATE UNIQUE INDEX "PartFieldDef_name_key" ON public."PartFieldDef" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "PartFieldValue_fieldId_idx" ON public."PartFieldValue" USING btree ("fieldId");



CREATE UNIQUE INDEX "PartFieldValue_partId_fieldId_key" ON public."PartFieldValue" USING btree ("partId", "fieldId");



CREATE INDEX "PartInspection_inspectionCodeId_idx" ON public."PartInspection" USING btree ("inspectionCodeId");



CREATE INDEX "PartInspection_partId_idx" ON public."PartInspection" USING btree ("partId");



CREATE INDEX "PartInspection_scaleId_idx" ON public."PartInspection" USING btree ("scaleId");



CREATE UNIQUE INDEX "PartPriceBreak_partPriceId_threshold_key" ON public."PartPriceBreak" USING btree ("partPriceId", threshold) WHERE ("deletedAt" IS NULL);



CREATE INDEX "PartPrice_partId_idx" ON public."PartPrice" USING btree ("partId");



CREATE UNIQUE INDEX "PartPrice_partId_processStepCodeId_key" ON public."PartPrice" USING btree ("partId", "processStepCodeId") WHERE ("deletedAt" IS NULL);



CREATE INDEX "PartPrice_processStepCodeId_idx" ON public."PartPrice" USING btree ("processStepCodeId");



CREATE INDEX "PartProcessRevision_partId_idx" ON public."PartProcessRevision" USING btree ("partId");



CREATE UNIQUE INDEX "PartProcessRevision_partId_revisionNumber_key" ON public."PartProcessRevision" USING btree ("partId", "revisionNumber");



CREATE INDEX "PartProcessStepParameter_stepId_idx" ON public."PartProcessStepParameter" USING btree ("stepId");



CREATE UNIQUE INDEX "PartProcessStepParameter_stepId_key_key" ON public."PartProcessStepParameter" USING btree ("stepId", key);



CREATE UNIQUE INDEX "PartProcessStepParameter_stepId_position_key" ON public."PartProcessStepParameter" USING btree ("stepId", "position");



CREATE INDEX "PartProcessStep_codeId_idx" ON public."PartProcessStep" USING btree ("codeId");



CREATE INDEX "PartProcessStep_revisionId_idx" ON public."PartProcessStep" USING btree ("revisionId");



CREATE UNIQUE INDEX "PartProcessStep_revisionId_position_key" ON public."PartProcessStep" USING btree ("revisionId", "position");



CREATE UNIQUE INDEX "PartRecipe_numberKey_key" ON public."PartRecipe" USING btree ("numberKey");



CREATE UNIQUE INDEX "PartRecipe_partId_key" ON public."PartRecipe" USING btree ("partId");



CREATE UNIQUE INDEX "PartSpecification_partId_specificationId_key" ON public."PartSpecification" USING btree ("partId", "specificationId") WHERE ("deletedAt" IS NULL);



CREATE INDEX "PartSpecification_specificationId_idx" ON public."PartSpecification" USING btree ("specificationId");



CREATE INDEX "Part_customerId_idx" ON public."Part" USING btree ("customerId");



CREATE UNIQUE INDEX "Part_customerId_partNumber_key" ON public."Part" USING btree ("customerId", "partNumber") WHERE ("deletedAt" IS NULL);



CREATE INDEX "Part_name_trgm_idx" ON public."Part" USING gin (name public.gin_trgm_ops);



CREATE INDEX "Part_partNumber_idx" ON public."Part" USING btree ("partNumber");



CREATE INDEX "Part_partNumber_trgm_idx" ON public."Part" USING gin ("partNumber" public.gin_trgm_ops);



CREATE UNIQUE INDEX "PaymentType_name_key" ON public."PaymentType" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "Payment_batchId_idx" ON public."Payment" USING btree ("batchId");



CREATE INDEX "Payment_customerId_idx" ON public."Payment" USING btree ("customerId");



CREATE INDEX "Payment_receivedDate_idx" ON public."Payment" USING btree ("receivedDate");



CREATE UNIQUE INDEX "ProcessStepCode_code_key" ON public."ProcessStepCode" USING btree (code) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "ProcessStepFieldDef_codeId_label_key" ON public."ProcessStepFieldDef" USING btree ("codeId", label) WHERE ("deletedAt" IS NULL);



CREATE INDEX "QuoteLine_materialId_idx" ON public."QuoteLine" USING btree ("materialId");



CREATE INDEX "QuoteLine_partId_idx" ON public."QuoteLine" USING btree ("partId");



CREATE INDEX "QuoteLine_quoteId_idx" ON public."QuoteLine" USING btree ("quoteId");



CREATE UNIQUE INDEX "QuotePriceBreak_quotePriceId_threshold_key" ON public."QuotePriceBreak" USING btree ("quotePriceId", threshold) WHERE ("deletedAt" IS NULL);



CREATE INDEX "QuotePrice_processStepCodeId_idx" ON public."QuotePrice" USING btree ("processStepCodeId");



CREATE INDEX "QuotePrice_quoteLineId_idx" ON public."QuotePrice" USING btree ("quoteLineId");



CREATE UNIQUE INDEX "QuotePrice_quoteLineId_processStepCodeId_key" ON public."QuotePrice" USING btree ("quoteLineId", "processStepCodeId") WHERE ("deletedAt" IS NULL);



CREATE INDEX "Quote_customerId_idx" ON public."Quote" USING btree ("customerId");



CREATE UNIQUE INDEX "Quote_quoteNumber_key" ON public."Quote" USING btree ("quoteNumber");



CREATE UNIQUE INDEX "ReceiptBatch_batchNumber_key" ON public."ReceiptBatch" USING btree ("batchNumber");



CREATE INDEX "ReceiptBatch_depositDate_idx" ON public."ReceiptBatch" USING btree ("depositDate");



CREATE INDEX "RecipeSnapshotField_fieldDefId_idx" ON public."RecipeSnapshotField" USING btree ("fieldDefId");



CREATE UNIQUE INDEX "RolePermission_roleId_permission_key" ON public."RolePermission" USING btree ("roleId", permission);



CREATE UNIQUE INDEX "Role_name_key" ON public."Role" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "SavedView_userId_name_key" ON public."SavedView" USING btree ("userId", name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "Session_tokenHash_key" ON public."Session" USING btree ("tokenHash");



CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId");



CREATE INDEX "ShipperContainer_orderContainerId_idx" ON public."ShipperContainer" USING btree ("orderContainerId");



CREATE UNIQUE INDEX "ShipperContainer_shipperOrderId_orderContainerId_key" ON public."ShipperContainer" USING btree ("shipperOrderId", "orderContainerId");



CREATE UNIQUE INDEX "ShipperContainer_shipperOrderId_position_key" ON public."ShipperContainer" USING btree ("shipperOrderId", "position");



CREATE INDEX "ShipperLine_orderLineId_idx" ON public."ShipperLine" USING btree ("orderLineId");



CREATE UNIQUE INDEX "ShipperLine_shipperOrderId_orderLineId_key" ON public."ShipperLine" USING btree ("shipperOrderId", "orderLineId");



CREATE UNIQUE INDEX "ShipperLine_shipperOrderId_position_key" ON public."ShipperLine" USING btree ("shipperOrderId", "position");



CREATE INDEX "ShipperOrder_orderId_idx" ON public."ShipperOrder" USING btree ("orderId");



CREATE UNIQUE INDEX "ShipperOrder_orderId_sequence_key" ON public."ShipperOrder" USING btree ("orderId", sequence);



CREATE UNIQUE INDEX "ShipperOrder_shipperId_orderId_key" ON public."ShipperOrder" USING btree ("shipperId", "orderId");



CREATE UNIQUE INDEX "ShipperOrder_shipperId_position_key" ON public."ShipperOrder" USING btree ("shipperId", "position");



CREATE INDEX "ShipperSerial_orderLineIdAtSave_serial_idx" ON public."ShipperSerial" USING btree ("orderLineIdAtSave", serial);



CREATE INDEX "ShipperSerial_orderSerialId_idx" ON public."ShipperSerial" USING btree ("orderSerialId");



CREATE UNIQUE INDEX "ShipperSerial_shipperOrderId_orderSerialId_key" ON public."ShipperSerial" USING btree ("shipperOrderId", "orderSerialId");



CREATE UNIQUE INDEX "Shipper_bolNumber_key" ON public."Shipper" USING btree ("bolNumber");



CREATE INDEX "Shipper_carrierId_idx" ON public."Shipper" USING btree ("carrierId");



CREATE UNIQUE INDEX "Shipper_clientRequestId_key" ON public."Shipper" USING btree ("clientRequestId");



CREATE INDEX "Shipper_customerId_idx" ON public."Shipper" USING btree ("customerId");



CREATE INDEX "Shipper_reversesShipperId_idx" ON public."Shipper" USING btree ("reversesShipperId");



CREATE INDEX "Shipper_shipDate_idx" ON public."Shipper" USING btree ("shipDate");



CREATE UNIQUE INDEX "Shipper_shipperNumber_key" ON public."Shipper" USING btree ("shipperNumber");



CREATE UNIQUE INDEX "Specification_name_key" ON public."Specification" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE INDEX "StoredDocument_certId_idx" ON public."StoredDocument" USING btree ("certId");



CREATE INDEX "StoredDocument_coveredOrderIds_idx" ON public."StoredDocument" USING gin ("coveredOrderIds");



CREATE INDEX "StoredDocument_customerId_idx" ON public."StoredDocument" USING btree ("customerId");



CREATE INDEX "StoredDocument_invoiceId_idx" ON public."StoredDocument" USING btree ("invoiceId");



CREATE INDEX "StoredDocument_orderId_idx" ON public."StoredDocument" USING btree ("orderId");



CREATE INDEX "StoredDocument_quoteId_idx" ON public."StoredDocument" USING btree ("quoteId");



CREATE INDEX "StoredDocument_shipperId_idx" ON public."StoredDocument" USING btree ("shipperId");



CREATE INDEX "StoredDocument_templateVersionId_idx" ON public."StoredDocument" USING btree ("templateVersionId");



CREATE UNIQUE INDEX "SurchargeStepCode_surchargeId_processStepCodeId_key" ON public."SurchargeStepCode" USING btree ("surchargeId", "processStepCodeId");



CREATE UNIQUE INDEX "Surcharge_name_key" ON public."Surcharge" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "Terms_name_key" ON public."Terms" USING btree (name) WHERE ("deletedAt" IS NULL);



CREATE UNIQUE INDEX "UserPermissionOverride_userId_permission_key" ON public."UserPermissionOverride" USING btree ("userId", permission);



CREATE UNIQUE INDEX "User_username_key" ON public."User" USING btree (username);



ALTER TABLE ONLY public."Application"
    ADD CONSTRAINT "Application_creditInvoiceId_fkey" FOREIGN KEY ("creditInvoiceId") REFERENCES public."Invoice"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Application"
    ADD CONSTRAINT "Application_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public."Invoice"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Application"
    ADD CONSTRAINT "Application_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES public."Payment"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_arGlAccountId_fkey" FOREIGN KEY ("arGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_certChargeStepCodeId_fkey" FOREIGN KEY ("certChargeStepCodeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_discountGlAccountId_fkey" FOREIGN KEY ("discountGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_freightGlAccountId_fkey" FOREIGN KEY ("freightGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_otherChargeGlAccountId_fkey" FOREIGN KEY ("otherChargeGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_salesTaxGlAccountId_fkey" FOREIGN KEY ("salesTaxGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."BillingConfig"
    ADD CONSTRAINT "BillingConfig_writeOffGlAccountId_fkey" FOREIGN KEY ("writeOffGlAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."CertReading"
    ADD CONSTRAINT "CertReading_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES public."CertRequirement"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CertRequirement"
    ADD CONSTRAINT "CertRequirement_certId_fkey" FOREIGN KEY ("certId") REFERENCES public."Cert"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CertRequirement"
    ADD CONSTRAINT "CertRequirement_inspectionCodeId_fkey" FOREIGN KEY ("inspectionCodeId") REFERENCES public."InspectionCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CertRequirement"
    ADD CONSTRAINT "CertRequirement_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."CertRequirement"
    ADD CONSTRAINT "CertRequirement_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES public."InspectionScale"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Cert"
    ADD CONSTRAINT "Cert_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Cert"
    ADD CONSTRAINT "Cert_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES public."Shipper"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."ClosePeriod"
    ADD CONSTRAINT "ClosePeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."CustomerAddress"
    ADD CONSTRAINT "CustomerAddress_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."CustomerContact"
    ADD CONSTRAINT "CustomerContact_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."CustomerSurcharge"
    ADD CONSTRAINT "CustomerSurcharge_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CustomerSurcharge"
    ADD CONSTRAINT "CustomerSurcharge_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES public."Surcharge"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CustomerTemplateAssignment"
    ADD CONSTRAINT "CustomerTemplateAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."CustomerTemplateAssignment"
    ADD CONSTRAINT "CustomerTemplateAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES public."DocumentTemplate"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Customer"
    ADD CONSTRAINT "Customer_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Customer"
    ADD CONSTRAINT "Customer_termsId_fkey" FOREIGN KEY ("termsId") REFERENCES public."Terms"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."DocumentTemplateVersion"
    ADD CONSTRAINT "DocumentTemplateVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."DocumentTemplateVersion"
    ADD CONSTRAINT "DocumentTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES public."DocumentTemplate"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."DocumentTemplate"
    ADD CONSTRAINT "DocumentTemplate_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES public."DocumentTemplateVersion"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."GlExportBatch"
    ADD CONSTRAINT "GlExportBatch_closePeriodId_fkey" FOREIGN KEY ("closePeriodId") REFERENCES public."ClosePeriod"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."GlExportBatch"
    ADD CONSTRAINT "GlExportBatch_emittedById_fkey" FOREIGN KEY ("emittedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."GlPosting"
    ADD CONSTRAINT "GlPosting_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES public."GlExportBatch"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."GlPosting"
    ADD CONSTRAINT "GlPosting_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InspectionCode"
    ADD CONSTRAINT "InspectionCode_defaultScaleId_fkey" FOREIGN KEY ("defaultScaleId") REFERENCES public."InspectionScale"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public."Invoice"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_orderChargeId_fkey" FOREIGN KEY ("orderChargeId") REFERENCES public."OrderCharge"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_parentLineId_fkey" FOREIGN KEY ("parentLineId") REFERENCES public."InvoiceLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."InvoiceLine"
    ADD CONSTRAINT "InvoiceLine_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES public."Surcharge"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Invoice"
    ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Invoice"
    ADD CONSTRAINT "Invoice_finalizedById_fkey" FOREIGN KEY ("finalizedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Invoice"
    ADD CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Invoice"
    ADD CONSTRAINT "Invoice_sourceInvoiceId_fkey" FOREIGN KEY ("sourceInvoiceId") REFERENCES public."Invoice"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Load"
    ADD CONSTRAINT "Load_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderAttachment"
    ADD CONSTRAINT "OrderAttachment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderCharge"
    ADD CONSTRAINT "OrderCharge_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderContainer"
    ADD CONSTRAINT "OrderContainer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderContainer"
    ADD CONSTRAINT "OrderContainer_typeId_fkey" FOREIGN KEY ("typeId") REFERENCES public."ContainerType"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderDraft"
    ADD CONSTRAINT "OrderDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderLine"
    ADD CONSTRAINT "OrderLine_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES public."QuoteLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."OrderSerial"
    ADD CONSTRAINT "OrderSerial_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."OrderSerial"
    ADD CONSTRAINT "OrderSerial_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Order"
    ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartAttachment"
    ADD CONSTRAINT "PartAttachment_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartFieldValue"
    ADD CONSTRAINT "PartFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES public."PartFieldDef"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartFieldValue"
    ADD CONSTRAINT "PartFieldValue_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartInspection"
    ADD CONSTRAINT "PartInspection_inspectionCodeId_fkey" FOREIGN KEY ("inspectionCodeId") REFERENCES public."InspectionCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartInspection"
    ADD CONSTRAINT "PartInspection_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartInspection"
    ADD CONSTRAINT "PartInspection_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES public."InspectionScale"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."PartPriceBreak"
    ADD CONSTRAINT "PartPriceBreak_partPriceId_fkey" FOREIGN KEY ("partPriceId") REFERENCES public."PartPrice"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartPrice"
    ADD CONSTRAINT "PartPrice_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartPrice"
    ADD CONSTRAINT "PartPrice_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartProcessRevision"
    ADD CONSTRAINT "PartProcessRevision_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartProcessRevision"
    ADD CONSTRAINT "PartProcessRevision_recipeId_fkey" FOREIGN KEY ("recipeId") REFERENCES public."PartRecipe"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartProcessStepParameter"
    ADD CONSTRAINT "PartProcessStepParameter_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES public."PartProcessStep"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartProcessStep"
    ADD CONSTRAINT "PartProcessStep_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartProcessStep"
    ADD CONSTRAINT "PartProcessStep_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES public."PartProcessRevision"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartRecipe"
    ADD CONSTRAINT "PartRecipe_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartSpecification"
    ADD CONSTRAINT "PartSpecification_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."PartSpecification"
    ADD CONSTRAINT "PartSpecification_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES public."Specification"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Part"
    ADD CONSTRAINT "Part_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Part"
    ADD CONSTRAINT "Part_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES public."Material"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."PaymentType"
    ADD CONSTRAINT "PaymentType_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Payment"
    ADD CONSTRAINT "Payment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES public."ReceiptBatch"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Payment"
    ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Payment"
    ADD CONSTRAINT "Payment_paymentTypeId_fkey" FOREIGN KEY ("paymentTypeId") REFERENCES public."PaymentType"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ProcessStepCode"
    ADD CONSTRAINT "ProcessStepCode_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."ProcessStepFieldDef"
    ADD CONSTRAINT "ProcessStepFieldDef_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."QuoteLine"
    ADD CONSTRAINT "QuoteLine_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES public."Material"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."QuoteLine"
    ADD CONSTRAINT "QuoteLine_partId_fkey" FOREIGN KEY ("partId") REFERENCES public."Part"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."QuoteLine"
    ADD CONSTRAINT "QuoteLine_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES public."Quote"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."QuotePriceBreak"
    ADD CONSTRAINT "QuotePriceBreak_quotePriceId_fkey" FOREIGN KEY ("quotePriceId") REFERENCES public."QuotePrice"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."QuotePrice"
    ADD CONSTRAINT "QuotePrice_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."QuotePrice"
    ADD CONSTRAINT "QuotePrice_quoteLineId_fkey" FOREIGN KEY ("quoteLineId") REFERENCES public."QuoteLine"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES public."CustomerContact"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_endingStatementId_fkey" FOREIGN KEY ("endingStatementId") REFERENCES public."EndingStatement"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Quote"
    ADD CONSTRAINT "Quote_quotedById_fkey" FOREIGN KEY ("quotedById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."RecipeSnapshotField"
    ADD CONSTRAINT "RecipeSnapshotField_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES public."PartProcessRevision"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."RolePermission"
    ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public."Role"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."SavedView"
    ADD CONSTRAINT "SavedView_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ShipperContainer"
    ADD CONSTRAINT "ShipperContainer_orderContainerId_fkey" FOREIGN KEY ("orderContainerId") REFERENCES public."OrderContainer"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."ShipperContainer"
    ADD CONSTRAINT "ShipperContainer_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES public."ShipperOrder"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ShipperLine"
    ADD CONSTRAINT "ShipperLine_orderLineId_fkey" FOREIGN KEY ("orderLineId") REFERENCES public."OrderLine"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."ShipperLine"
    ADD CONSTRAINT "ShipperLine_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES public."ShipperOrder"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ShipperOrder"
    ADD CONSTRAINT "ShipperOrder_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ShipperOrder"
    ADD CONSTRAINT "ShipperOrder_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES public."Shipper"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."ShipperSerial"
    ADD CONSTRAINT "ShipperSerial_orderSerialId_fkey" FOREIGN KEY ("orderSerialId") REFERENCES public."OrderSerial"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."ShipperSerial"
    ADD CONSTRAINT "ShipperSerial_shipperOrderId_fkey" FOREIGN KEY ("shipperOrderId") REFERENCES public."ShipperOrder"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Shipper"
    ADD CONSTRAINT "Shipper_carrierId_fkey" FOREIGN KEY ("carrierId") REFERENCES public."Carrier"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Shipper"
    ADD CONSTRAINT "Shipper_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."Shipper"
    ADD CONSTRAINT "Shipper_reversesShipperId_fkey" FOREIGN KEY ("reversesShipperId") REFERENCES public."Shipper"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."Shipper"
    ADD CONSTRAINT "Shipper_shipToAddressId_fkey" FOREIGN KEY ("shipToAddressId") REFERENCES public."CustomerAddress"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_certId_fkey" FOREIGN KEY ("certId") REFERENCES public."Cert"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES public."Customer"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES public."Invoice"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES public."Order"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES public."Quote"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_shipperId_fkey" FOREIGN KEY ("shipperId") REFERENCES public."Shipper"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."StoredDocument"
    ADD CONSTRAINT "StoredDocument_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES public."DocumentTemplateVersion"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."SurchargeStepCode"
    ADD CONSTRAINT "SurchargeStepCode_processStepCodeId_fkey" FOREIGN KEY ("processStepCodeId") REFERENCES public."ProcessStepCode"(id) ON UPDATE CASCADE ON DELETE RESTRICT;



ALTER TABLE ONLY public."SurchargeStepCode"
    ADD CONSTRAINT "SurchargeStepCode_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES public."Surcharge"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."Surcharge"
    ADD CONSTRAINT "Surcharge_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES public."GlAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."UpdateHold"
    ADD CONSTRAINT "UpdateHold_heldById_fkey" FOREIGN KEY ("heldById") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE SET NULL;



ALTER TABLE ONLY public."UserPermissionOverride"
    ADD CONSTRAINT "UserPermissionOverride_userId_fkey" FOREIGN KEY ("userId") REFERENCES public."User"(id) ON UPDATE CASCADE ON DELETE CASCADE;



ALTER TABLE ONLY public."User"
    ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES public."Role"(id) ON UPDATE CASCADE ON DELETE SET NULL;

-- Public lineage marker: successful bootstrap inserts its sole row after validation.
CREATE TABLE "PublicInstallation" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lineage" TEXT NOT NULL,
    "baselineMigration" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PublicInstallation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "PublicInstallation_singleton_check" CHECK ("id" = 'singleton'),
    CONSTRAINT "PublicInstallation_lineage_check" CHECK ("lineage" = 'heatsynq-public-v2'),
    CONSTRAINT "PublicInstallation_baseline_check" CHECK ("baselineMigration" = '20261120000000_public_baseline_v2')
);

-- Required clean initialization; no users, audit history, or business records.
INSERT INTO "BillingConfig" ("id", "billForCertDefault", "updatedAt") VALUES ('singleton', false, now());
INSERT INTO "SetupState" ("id", "updatedAt") VALUES ('singleton', now());
INSERT INTO "UpdateHold" ("id", "updatedAt") VALUES ('singleton', now());

INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-traveler', 'TRAVELER'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-traveler-v1', 'standard-traveler', 1, 'PUBLISHED', '{"fonts":{"baseSize":8,"family":"Roboto","headingSize":12,"smallSize":6.5},"formats":{"thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"customer_name","label":null,"visible":true,"width":null},{"key":"received_from","label":null,"visible":true,"width":null},{"key":"customer_phone","label":null,"visible":true,"width":null},{"key":"po_number","label":null,"visible":true,"width":null},{"key":"company_name","label":null,"visible":true,"width":null},{"key":"company_address","label":null,"visible":true,"width":null},{"key":"company_phone","label":null,"visible":true,"width":null},{"key":"order_number","label":null,"visible":true,"width":null},{"key":"load_number","label":null,"visible":true,"width":null},{"key":"barcode","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"line_qty","label":null,"visible":true,"width":null},{"key":"line_part","label":null,"visible":true,"width":null},{"key":"line_each_weight","label":null,"visible":true,"width":null},{"key":"line_weight","label":null,"visible":true,"width":null}],"key":"lines","visible":true},{"fields":[{"key":"order_qty","label":null,"visible":true,"width":null},{"key":"load_qty","label":null,"visible":true,"width":null},{"key":"container","label":null,"visible":true,"width":null},{"key":"container_qty","label":null,"visible":true,"width":null},{"key":"tare_weight","label":null,"visible":true,"width":null},{"key":"gross_weight","label":null,"visible":true,"width":null}],"key":"quantities","visible":true},{"fields":[{"key":"process","label":null,"visible":true,"width":null},{"key":"material","label":null,"visible":true,"width":null},{"key":"process_id","label":null,"visible":true,"width":null}],"key":"process","visible":true},{"fields":[{"key":"inspections_title","label":null,"visible":true,"width":null},{"key":"inspection_code","label":null,"visible":true,"width":null},{"key":"inspection_scale","label":null,"visible":true,"width":null},{"key":"inspection_min","label":null,"visible":true,"width":null},{"key":"inspection_max","label":null,"visible":true,"width":null},{"key":"inspection_qty","label":null,"visible":true,"width":null},{"key":"inspection_location","label":null,"visible":true,"width":null}],"key":"inspections","visible":true},{"fields":[{"key":"steps_title","label":null,"visible":true,"width":null},{"key":"step_position","label":null,"visible":true,"width":null},{"key":"step_code","label":null,"visible":true,"width":null},{"key":"step_instruction","label":null,"visible":true,"width":null},{"key":"step_values","label":null,"visible":true,"width":null},{"key":"step_eq","label":null,"visible":true,"width":null},{"key":"step_op","label":null,"visible":true,"width":null},{"key":"step_date","label":null,"visible":true,"width":null}],"key":"steps","visible":true},{"fields":[{"key":"results","label":null,"visible":true,"width":null},{"key":"tempered_results","label":null,"visible":true,"width":null},{"key":"final_inspection","label":null,"visible":true,"width":null},{"key":"pass","label":null,"visible":true,"width":null},{"key":"fail","label":null,"visible":true,"width":null},{"key":"tested_by","label":null,"visible":true,"width":null},{"key":"tested_date","label":null,"visible":true,"width":null},{"key":"ok_to_ship","label":null,"visible":true,"width":null},{"key":"ship_date","label":null,"visible":true,"width":null}],"key":"footer","visible":true}],"textBlocks":{}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-traveler-v1' WHERE "id" = 'standard-traveler';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-shipper', 'SHIPPER'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-shipper-v1', 'standard-shipper', 1, 'PUBLISHED', '{"fonts":{"baseSize":8,"family":"Roboto","headingSize":16,"smallSize":5.5},"formats":{"dateFormat":"M/D/YYYY","thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"company_name","label":null,"visible":true,"width":null},{"key":"title","label":null,"visible":true,"width":null},{"key":"order_no","label":null,"visible":true,"width":null},{"key":"ship_date","label":null,"visible":true,"width":null},{"key":"company_address","label":null,"visible":true,"width":null},{"key":"company_phone","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"sold_to","label":null,"visible":true,"width":null},{"key":"ship_to","label":null,"visible":true,"width":null}],"key":"parties","visible":true},{"fields":[{"key":"po_number","label":null,"visible":true,"width":null},{"key":"packing_list_no","label":null,"visible":true,"width":null},{"key":"customer_job_no","label":null,"visible":true,"width":null},{"key":"route","label":null,"visible":true,"width":null},{"key":"carrier","label":null,"visible":true,"width":null}],"key":"field_strip","visible":true},{"fields":[{"key":"line_qty","label":null,"visible":true,"width":null},{"key":"line_part","label":null,"visible":true,"width":null},{"key":"line_pounds","label":null,"visible":true,"width":null}],"key":"lines","visible":true},{"fields":[{"key":"container_type","label":null,"visible":true,"width":null},{"key":"container_count","label":null,"visible":true,"width":null},{"key":"container_tare","label":null,"visible":true,"width":null},{"key":"cust_cont_id","label":null,"visible":true,"width":null}],"key":"containers","visible":true},{"fields":[{"key":"serials","label":null,"visible":true,"width":null}],"key":"serials","visible":true},{"fields":[],"key":"liability","visible":true},{"fields":[{"key":"shipped_complete","label":null,"visible":true,"width":null},{"key":"total_qty","label":null,"visible":true,"width":null},{"key":"total_weight","label":null,"visible":true,"width":null},{"key":"total_tare","label":null,"visible":true,"width":null},{"key":"total_gross","label":null,"visible":true,"width":null}],"key":"totals","visible":true},{"fields":[{"key":"tear_order_no","label":null,"visible":true,"width":null},{"key":"tear_shipped_complete","label":null,"visible":true,"width":null},{"key":"tear_total_qty","label":null,"visible":true,"width":null},{"key":"tear_total_weight","label":null,"visible":true,"width":null},{"key":"received_by","label":null,"visible":true,"width":null},{"key":"received_date","label":null,"visible":true,"width":null},{"key":"tear_sold_to","label":null,"visible":true,"width":null},{"key":"shipped_on","label":null,"visible":true,"width":null}],"key":"tear_off","visible":true}],"textBlocks":{"shipper_liability_text":""}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-shipper-v1' WHERE "id" = 'standard-shipper';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-mos-shipper', 'MOS_SHIPPER'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-mos-shipper-v1', 'standard-mos-shipper', 1, 'PUBLISHED', '{"fonts":{"baseSize":8,"family":"Roboto","headingSize":16,"smallSize":5.5},"formats":{"dateFormat":"M/D/YYYY","thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"company_name","label":null,"visible":true,"width":null},{"key":"title","label":null,"visible":true,"width":null},{"key":"order_no","label":null,"visible":true,"width":null},{"key":"ship_date","label":null,"visible":true,"width":null},{"key":"company_address","label":null,"visible":true,"width":null},{"key":"company_phone","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"sold_to","label":null,"visible":true,"width":null},{"key":"ship_to","label":null,"visible":true,"width":null}],"key":"parties","visible":true},{"fields":[{"key":"po_number","label":null,"visible":true,"width":null},{"key":"packing_list_no","label":null,"visible":true,"width":null},{"key":"customer_job_no","label":null,"visible":true,"width":null},{"key":"route","label":null,"visible":true,"width":null},{"key":"carrier","label":null,"visible":true,"width":null}],"key":"field_strip","visible":true},{"fields":[{"key":"line_qty","label":null,"visible":true,"width":null},{"key":"line_part","label":null,"visible":true,"width":null},{"key":"line_pounds","label":null,"visible":true,"width":null}],"key":"lines","visible":true},{"fields":[{"key":"container_type","label":null,"visible":true,"width":null},{"key":"container_count","label":null,"visible":true,"width":null},{"key":"container_tare","label":null,"visible":true,"width":null},{"key":"cust_cont_id","label":null,"visible":true,"width":null}],"key":"containers","visible":true},{"fields":[{"key":"serials","label":null,"visible":true,"width":null}],"key":"serials","visible":true},{"fields":[],"key":"liability","visible":true},{"fields":[{"key":"shipped_complete","label":null,"visible":true,"width":null},{"key":"total_qty","label":null,"visible":true,"width":null},{"key":"total_weight","label":null,"visible":true,"width":null},{"key":"total_tare","label":null,"visible":true,"width":null},{"key":"total_gross","label":null,"visible":true,"width":null}],"key":"totals","visible":true},{"fields":[{"key":"tear_order_no","label":null,"visible":true,"width":null},{"key":"tear_shipped_complete","label":null,"visible":true,"width":null},{"key":"tear_total_qty","label":null,"visible":true,"width":null},{"key":"tear_total_weight","label":null,"visible":true,"width":null},{"key":"received_by","label":null,"visible":true,"width":null},{"key":"received_date","label":null,"visible":true,"width":null},{"key":"tear_sold_to","label":null,"visible":true,"width":null},{"key":"shipped_on","label":null,"visible":true,"width":null}],"key":"tear_off","visible":true}],"textBlocks":{"shipper_liability_text":""}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-mos-shipper-v1' WHERE "id" = 'standard-mos-shipper';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-bol', 'BOL'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-bol-v1', 'standard-bol', 1, 'PUBLISHED', '{"fonts":{"baseSize":7,"family":"Roboto","headingSize":15,"smallSize":5.5},"formats":{"dateFormat":"MMM - DD - YYYY","thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"original_label","label":null,"visible":true,"width":null},{"key":"title","label":null,"visible":true,"width":null},{"key":"pro_number","label":null,"visible":true,"width":null},{"key":"bol_number","label":null,"visible":true,"width":null},{"key":"consignee_ref","label":null,"visible":true,"width":null},{"key":"scac_code","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"carrier_name","label":null,"visible":true,"width":null}],"key":"carrier","visible":true},{"fields":[{"key":"ship_from","label":null,"visible":true,"width":null}],"key":"received","visible":true},{"fields":[{"key":"consigned_to","label":null,"visible":true,"width":null},{"key":"destination","label":null,"visible":true,"width":null},{"key":"destination_state","label":null,"visible":true,"width":null},{"key":"destination_zip","label":null,"visible":true,"width":null}],"key":"consigned","visible":true},{"fields":[{"key":"trv_no","label":null,"visible":true,"width":null}],"key":"trv","visible":true},{"fields":[{"key":"delivering_carrier","label":null,"visible":true,"width":null},{"key":"vehicle_initials","label":null,"visible":true,"width":null},{"key":"vehicle_no","label":null,"visible":true,"width":null}],"key":"delivering_carrier","visible":true},{"fields":[{"key":"package_count","label":null,"visible":true,"width":null},{"key":"freight_description","label":null,"visible":true,"width":null},{"key":"freight_weight","label":null,"visible":true,"width":null},{"key":"freight_class","label":null,"visible":true,"width":null},{"key":"check_column","label":null,"visible":true,"width":null},{"key":"collect_checkbox","label":null,"visible":true,"width":null}],"key":"freight","visible":true},{"fields":[{"key":"shipper_per","label":null,"visible":true,"width":null},{"key":"agent_per","label":null,"visible":true,"width":null},{"key":"po_address","label":null,"visible":true,"width":null}],"key":"bottom","visible":true}],"textBlocks":{"bol_certifies_text":"Shipper hereby certifies that he is familiar with all the terms and conditions of the said bill of lading, set forth in the classification of tariff which governs the transportation of this shipment, and the said terms and conditions are hereby agreed to by the shipper and accepted for himself and his assigns.","bol_declared_value_text":"The agreed or declared value of the property is hereby specifically stated by the shipper to be not exceeding","bol_fibre_note":"†The fibre boxes used for this shipment conform to the specifications set forth in the box marker''s certificate thereon, and all other requirements of the Consolidated Freight Classification.","bol_imprint_text":"†Shipper''s imprint in lieu of stamps, not a part of Bill of Lading approved by the Interstate Comerce Commission.","bol_liability_note":"Liability Limitation for loss or damage on this shipment may be applicable. See 49 U.S.C. § 14706(c)(1)(A) and (B).","bol_no_delivery_text":"The carrier shall not make delivery of this shipment without payment of freight and all other lawful charges.","bol_property_text":"the property described below, in apparent good order, except as noted (contents and condition of contents of packages unknown), marked, consigned, and destined as indicated below, which said carrier (the word carrier being understood throughout the contract as meaning any person or corporation in possession of the property under the contract), agree to carry to its usual place of delivery at said destination, if on its route, otherwise to deliver to another carrier on the route to said destination. It is mutually agreed, as to each carrier of all or any of said property over all or any portion of said route to destination, and as to each party at any time interested in all or any said property, that every service to be performed here under shall be subject to all the terms and conditions of the Uniform Domestic Straight Bill of Lading set forth (I) in Official, Southern, Western and Illinois Freight Classification in effect on the date hereof, if this is a rail or a rail-water shipment, or (2) in the applicable motor carrier classification or tariff if this is a motor carrier shipment.","bol_received_text":"RECEIVED, subject to individually determined rates of contracts that have been agreed upon in writing between the carrier and shipper. If applicable, otherwise to the rates, classifications and rules that have been established by the carrier and are available to the shipper, on request;","bol_section_7_text":"Subject to Section 7 of Conditions of applicable bill of lading, if this shipment is to be delivered to the consignee without recourse on the consignor, the consignor shall sign the following statement.","bol_value_note":"NOTE - Where the rate is dependent on value, shippers are required to state specifically in writing the agreed or declared value of the property.","bol_water_note":"* If the shipment moves between two ports by a carrier by water, the law requires that the bill of lading state whether it is carrier''s or shipper''s weight."}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-bol-v1' WHERE "id" = 'standard-bol';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-cert', 'CERT'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-cert-v1', 'standard-cert', 1, 'PUBLISHED', '{"fonts":{"baseSize":9,"family":"Roboto","headingSize":19,"smallSize":7.5},"formats":{"dateFormat":"MM/DD/YYYY","thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"company_name","label":null,"visible":true,"width":null},{"key":"title","label":null,"visible":true,"width":null},{"key":"order_no","label":null,"visible":true,"width":null},{"key":"print_date","label":null,"visible":true,"width":null},{"key":"entry_date","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"to","label":null,"visible":true,"width":null},{"key":"po_number","label":null,"visible":true,"width":null},{"key":"packing_list_no","label":null,"visible":true,"width":null},{"key":"material","label":null,"visible":true,"width":null}],"key":"parties","visible":true},{"fields":[{"key":"part_qty","label":null,"visible":true,"width":null},{"key":"part_identity","label":null,"visible":true,"width":null},{"key":"part_pounds","label":null,"visible":true,"width":null}],"key":"parts","visible":true},{"fields":[],"key":"statement","visible":true},{"fields":[{"key":"part_heading","label":null,"visible":true,"width":null},{"key":"spec_line","label":null,"visible":true,"width":null},{"key":"readings","label":null,"visible":true,"width":null}],"key":"requirements","visible":true},{"fields":[{"key":"serials","label":null,"visible":true,"width":null}],"key":"serials","visible":true},{"fields":[{"key":"freeform","label":null,"visible":true,"width":null}],"key":"freeform","visible":true},{"fields":[{"key":"signature_mark","label":null,"visible":true,"width":null},{"key":"signer_name","label":null,"visible":true,"width":null},{"key":"signer_title","label":null,"visible":true,"width":null},{"key":"signer_company","label":null,"visible":true,"width":null}],"key":"signature","visible":true},{"fields":[{"key":"footer_address","label":null,"visible":true,"width":null},{"key":"footer_phone","label":null,"visible":true,"width":null}],"key":"footer","visible":true}],"textBlocks":{"cert_statement":""}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-cert-v1' WHERE "id" = 'standard-cert';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-invoice', 'INVOICE'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-invoice-v1', 'standard-invoice', 1, 'PUBLISHED', '{"fonts":{"baseSize":9,"family":"Roboto","headingSize":20,"smallSize":7.5},"formats":{"dateFormat":"MMMM D, YYYY","negativeStyle":"SIGN_AFTER_SYMBOL","priceDecimals":2,"thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"title","label":null,"visible":true,"width":null},{"key":"company_name","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"invoice_no","label":null,"visible":true,"width":null},{"key":"invoice_date","label":null,"visible":true,"width":null},{"key":"terms","label":null,"visible":true,"width":null},{"key":"remit_to","label":null,"visible":true,"width":null}],"key":"identity","visible":true},{"fields":[{"key":"bill_to","label":null,"visible":true,"width":null},{"key":"ship_to","label":null,"visible":true,"width":null}],"key":"parties","visible":true},{"fields":[{"key":"col_qty","label":null,"visible":true,"width":null},{"key":"col_info","label":null,"visible":true,"width":null},{"key":"col_each_weight","label":null,"visible":true,"width":null},{"key":"col_amount","label":null,"visible":true,"width":null}],"key":"column_header","visible":true},{"fields":[{"key":"our_order_no","label":null,"visible":true,"width":null},{"key":"your_po","label":null,"visible":true,"width":null},{"key":"material","label":null,"visible":true,"width":null},{"key":"process","label":null,"visible":true,"width":null},{"key":"parts_heading","label":null,"visible":true,"width":null}],"key":"order_strip","visible":true},{"fields":[{"key":"part_qty","label":null,"visible":true,"width":null},{"key":"part_identity","label":null,"visible":true,"width":null},{"key":"part_each_weight","label":null,"visible":true,"width":null},{"key":"part_total_weight","label":null,"visible":true,"width":null}],"key":"parts","visible":true},{"fields":[{"key":"price_heading","label":null,"visible":true,"width":null},{"key":"price_description","label":null,"visible":true,"width":null},{"key":"price_amount","label":null,"visible":true,"width":null},{"key":"quote_source","label":null,"visible":true,"width":null},{"key":"price_per","label":null,"visible":true,"width":null},{"key":"minimum_charge","label":null,"visible":true,"width":null},{"key":"setup_charge","label":null,"visible":true,"width":null}],"key":"price","visible":true},{"fields":[{"key":"subtotal","label":null,"visible":true,"width":null},{"key":"surcharge_rows","label":null,"visible":true,"width":null},{"key":"charge_rows","label":null,"visible":true,"width":null},{"key":"cert_row","label":null,"visible":true,"width":null},{"key":"freight_row","label":null,"visible":true,"width":null},{"key":"tax_row","label":null,"visible":true,"width":null},{"key":"total","label":null,"visible":true,"width":null}],"key":"totals","visible":true},{"fields":[{"key":"footer_address","label":null,"visible":true,"width":null},{"key":"footer_contact","label":null,"visible":true,"width":null},{"key":"footer_phone","label":null,"visible":true,"width":null}],"key":"footer","visible":true}],"textBlocks":{}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-invoice-v1' WHERE "id" = 'standard-invoice';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-statement', 'STATEMENT'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-statement-v1', 'standard-statement', 1, 'PUBLISHED', '{"fonts":{"baseSize":9,"family":"Roboto","headingSize":20,"smallSize":9},"formats":{"dateFormat":"MMMM D, YYYY","negativeStyle":"SIGN_AFTER_SYMBOL","priceDecimals":2,"thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"title","label":null,"visible":true,"width":null},{"key":"company_name","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"customer","label":null,"visible":true,"width":null},{"key":"statement_date","label":null,"visible":true,"width":null},{"key":"bill_to","label":null,"visible":true,"width":null},{"key":"remit_to","label":null,"visible":true,"width":null}],"key":"identity","visible":true},{"fields":[{"key":"document_no","label":null,"visible":true,"width":null},{"key":"date","label":null,"visible":true,"width":null},{"key":"due_date","label":null,"visible":true,"width":null},{"key":"original","label":null,"visible":true,"width":null},{"key":"open","label":null,"visible":true,"width":null}],"key":"open_items","visible":true},{"fields":[{"key":"aging_current","label":null,"visible":true,"width":null},{"key":"aging_1_30","label":null,"visible":true,"width":null},{"key":"aging_31_60","label":null,"visible":true,"width":null},{"key":"aging_61_90","label":null,"visible":true,"width":null},{"key":"aging_90_plus","label":null,"visible":true,"width":null},{"key":"aging_unapplied","label":null,"visible":true,"width":null},{"key":"aging_net","label":null,"visible":true,"width":null}],"key":"aging","visible":true},{"fields":[{"key":"finance_charge","label":null,"visible":true,"width":null}],"key":"finance_charge","visible":true},{"fields":[{"key":"total_due","label":null,"visible":true,"width":null}],"key":"total","visible":true}],"textBlocks":{}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-statement-v1' WHERE "id" = 'standard-statement';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-quote', 'QUOTE'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-quote-v1', 'standard-quote', 1, 'PUBLISHED', '{"fonts":{"baseSize":9,"family":"Roboto","headingSize":20,"smallSize":6.5},"formats":{"dateFormat":"MM/DD/YYYY","priceDecimals":4,"thousandsSeparator":true},"layout":null,"logo":null,"pageFooter":true,"sections":[{"fields":[{"key":"title","label":null,"visible":true,"width":null},{"key":"company_name","label":null,"visible":true,"width":null},{"key":"company_address","label":null,"visible":true,"width":null},{"key":"quote_number","label":null,"visible":true,"width":null}],"key":"header","visible":true},{"fields":[{"key":"attn","label":null,"visible":true,"width":null},{"key":"bill_to","label":null,"visible":true,"width":null},{"key":"company_phone","label":null,"visible":true,"width":null},{"key":"effective","label":null,"visible":true,"width":null},{"key":"expires","label":null,"visible":true,"width":null},{"key":"terms","label":null,"visible":true,"width":null},{"key":"rfq_number","label":null,"visible":true,"width":null},{"key":"customer_phone","label":null,"visible":true,"width":null}],"key":"parties","visible":true},{"fields":[],"key":"intro","visible":true},{"fields":[{"key":"col_qty","label":null,"visible":true,"width":null},{"key":"col_info","label":null,"visible":true,"width":null},{"key":"col_each_weight","label":null,"visible":true,"width":null},{"key":"col_amount","label":null,"visible":true,"width":null}],"key":"column_header","visible":true},{"fields":[{"key":"line_qty","label":null,"visible":true,"width":null},{"key":"line_part","label":null,"visible":true,"width":null},{"key":"line_each_weight","label":null,"visible":true,"width":null},{"key":"line_total_lbs","label":null,"visible":true,"width":null},{"key":"material","label":null,"visible":true,"width":null},{"key":"price_heading","label":null,"visible":true,"width":null},{"key":"step_name","label":null,"visible":true,"width":null},{"key":"step_notes","label":null,"visible":true,"width":null},{"key":"price_amount","label":null,"visible":true,"width":null},{"key":"setup_charge","label":null,"visible":true,"width":null},{"key":"price_per","label":null,"visible":true,"width":null},{"key":"minimum_charge","label":null,"visible":true,"width":null},{"key":"breaks","label":null,"visible":true,"width":null},{"key":"surcharge_estimate","label":null,"visible":true,"width":null}],"key":"lines","visible":true},{"fields":[{"key":"ending_statement","label":null,"visible":true,"width":null},{"key":"quote_notes","label":null,"visible":true,"width":null},{"key":"signer_name","label":null,"visible":true,"width":null},{"key":"signer_title","label":null,"visible":true,"width":null}],"key":"closing","visible":true},{"fields":[],"key":"liability","visible":true}],"textBlocks":{"quote_intro_text":"We are pleased to provide you with the following quotation:","quote_liability_text":""}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-quote-v1' WHERE "id" = 'standard-quote';
INSERT INTO "DocumentTemplate" ("id", "docType", "name", "isDefault", "createdAt", "updatedAt") VALUES ('standard-container-tag', 'CONTAINER_TAG'::"TemplateDocType", 'Standard', true, now(), now());
INSERT INTO "DocumentTemplateVersion" ("id", "templateId", "versionNumber", "status", "config", "publishedAt", "createdAt", "updatedAt") VALUES ('standard-container-tag-v1', 'standard-container-tag', 1, 'PUBLISHED', '{"fonts":{"baseSize":10,"family":"Roboto","headingSize":20,"smallSize":10},"formats":{"labelSize":"4x3-landscape"},"layout":null,"logo":null,"pageFooter":false,"sections":[{"fields":[{"key":"order_number","label":null,"visible":true,"width":null},{"key":"customer","label":null,"visible":true,"width":null},{"key":"po_number","label":null,"visible":true,"width":null},{"key":"containers_total","label":null,"visible":true,"width":null},{"key":"received","label":null,"visible":true,"width":null},{"key":"parts","label":null,"visible":true,"width":null}],"key":"tag","visible":true}],"textBlocks":{}}'::jsonb, now(), now(), now());
UPDATE "DocumentTemplate" SET "publishedVersionId" = 'standard-container-tag-v1' WHERE "id" = 'standard-container-tag';

COMMIT;
