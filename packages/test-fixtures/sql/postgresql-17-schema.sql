--
-- PostgreSQL database dump
--

\restrict HerdImport17Fixture

-- Dumped from database version 17.12 (Debian 17.12-1.pgdg12+1)
-- Dumped by pg_dump version 17.12 (Debian 17.12-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: import_lab; Type: SCHEMA; Schema: -; Owner: postgres
--

CREATE SCHEMA import_lab;


ALTER SCHEMA import_lab OWNER TO postgres;

--
-- Name: SCHEMA import_lab; Type: COMMENT; Schema: -; Owner: postgres
--

COMMENT ON SCHEMA import_lab IS '가져오기 검증 스키마';


--
-- Name: status; Type: TYPE; Schema: import_lab; Owner: postgres
--

CREATE TYPE import_lab.status AS ENUM (
    'open',
    'closed',
    'owner''s'
);


ALTER TYPE import_lab.status OWNER TO postgres;

--
-- Name: TYPE status; Type: COMMENT; Schema: import_lab; Owner: postgres
--

COMMENT ON TYPE import_lab.status IS '처리 상태';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Dispatch; Type: TABLE; Schema: import_lab; Owner: postgres
--

CREATE TABLE import_lab."Dispatch" (
    region integer NOT NULL,
    number bigint NOT NULL,
    status import_lab.status DEFAULT 'open'::import_lab.status,
    tags text[] DEFAULT ARRAY['a;b'::text, '한글'::text],
    peer_id integer,
    CONSTRAINT dispatch_region_check CHECK ((region > 0))
);


ALTER TABLE import_lab."Dispatch" OWNER TO postgres;

--
-- Name: TABLE "Dispatch"; Type: COMMENT; Schema: import_lab; Owner: postgres
--

COMMENT ON TABLE import_lab."Dispatch" IS '출고 ''테이블''
다음 줄';


--
-- Name: COLUMN "Dispatch".number; Type: COMMENT; Schema: import_lab; Owner: postgres
--

COMMENT ON COLUMN import_lab."Dispatch".number IS '식별 번호';


--
-- Name: Peer; Type: TABLE; Schema: import_lab; Owner: postgres
--

CREATE TABLE import_lab."Peer" (
    id integer NOT NULL,
    dispatch_region integer,
    dispatch_number bigint,
    parent_id integer,
    code text DEFAULT 'semi;quote''s
끝'::text
);


ALTER TABLE import_lab."Peer" OWNER TO postgres;

--
-- Name: Peer_id_seq; Type: SEQUENCE; Schema: import_lab; Owner: postgres
--

CREATE SEQUENCE import_lab."Peer_id_seq"
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE import_lab."Peer_id_seq" OWNER TO postgres;

--
-- Name: Peer_id_seq; Type: SEQUENCE OWNED BY; Schema: import_lab; Owner: postgres
--

ALTER SEQUENCE import_lab."Peer_id_seq" OWNED BY import_lab."Peer".id;


--
-- Name: dispatch_ticket; Type: SEQUENCE; Schema: import_lab; Owner: postgres
--

ALTER TABLE import_lab."Dispatch" ALTER COLUMN number ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME import_lab.dispatch_ticket
    START WITH 7
    INCREMENT BY 2
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: Peer id; Type: DEFAULT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Peer" ALTER COLUMN id SET DEFAULT nextval('import_lab."Peer_id_seq"'::regclass);


--
-- Name: Peer Peer_pkey; Type: CONSTRAINT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Peer"
    ADD CONSTRAINT "Peer_pkey" PRIMARY KEY (id);


--
-- Name: Dispatch dispatch_pk; Type: CONSTRAINT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Dispatch"
    ADD CONSTRAINT dispatch_pk PRIMARY KEY (region, number);


--
-- Name: peer_code_uq; Type: INDEX; Schema: import_lab; Owner: postgres
--

CREATE UNIQUE INDEX peer_code_uq ON import_lab."Peer" USING btree (code);


--
-- Name: Dispatch dispatch_peer_fk; Type: FK CONSTRAINT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Dispatch"
    ADD CONSTRAINT dispatch_peer_fk FOREIGN KEY (peer_id) REFERENCES import_lab."Peer"(id);


--
-- Name: Peer peer_dispatch_fk; Type: FK CONSTRAINT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Peer"
    ADD CONSTRAINT peer_dispatch_fk FOREIGN KEY (dispatch_region, dispatch_number) REFERENCES import_lab."Dispatch"(region, number) ON DELETE CASCADE;


--
-- Name: Peer peer_parent_fk; Type: FK CONSTRAINT; Schema: import_lab; Owner: postgres
--

ALTER TABLE ONLY import_lab."Peer"
    ADD CONSTRAINT peer_parent_fk FOREIGN KEY (parent_id) REFERENCES import_lab."Peer"(id);


--
-- PostgreSQL database dump complete
--

\unrestrict HerdImport17Fixture
