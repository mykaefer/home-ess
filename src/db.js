'use strict';

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');
const { hashPassword, isHashed } = require('./auth/password');
const metrics = require('./runtime-metrics');

// Öffnet (und initialisiert beim ersten Start) die SQLite-Datenbank.
// Schema, Seed-Daten und Migrationen sind hier gebündelt, damit der Rest der
// Anwendung von einer fertig eingerichteten DB ausgehen kann.
function openDatabase() {
  const dbDir = path.dirname(config.DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new sqlite3.Database(config.DB_PATH);
  if (metrics.enabled) {
    db.on('profile', (_sql, durationMs) => {
      metrics.counter('sqlite.queries');
      metrics.counter('sqlite.ms', Number(durationMs) || 0);
    });
  }

  db.serialize(() => {
    db.run(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT 'Administrator',
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'write',
        is_admin INTEGER NOT NULL DEFAULT 0,
        visible_pages TEXT
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS mqtt_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        host TEXT,
        port INTEGER,
        username TEXT,
        password TEXT,
        latitude REAL,
        longitude REAL,
        timezone TEXT,
        dst_enabled INTEGER NOT NULL DEFAULT 1,
        outdoor_temperature_topic TEXT,
        clock_time_topic TEXT,
        clock_date_topic TEXT
      )`
    );
    db.run(
      'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, user_id INTEGER)'
    );
    db.run(
      'CREATE TABLE IF NOT EXISTS stromverbrauch_config (id INTEGER PRIMARY KEY CHECK (id = 1), current_topic TEXT, eigenverbrauch_l1_topic TEXT, eigenverbrauch_l2_topic TEXT, eigenverbrauch_l3_topic TEXT, netzbezug_l1_topic TEXT, netzbezug_l2_topic TEXT, netzbezug_l3_topic TEXT, today_topic TEXT, netzbezug_zaehler_l1_topic TEXT, netzbezug_zaehler_l2_topic TEXT, netzbezug_zaehler_l3_topic TEXT, einspeisung_zaehler_l1_topic TEXT, einspeisung_zaehler_l2_topic TEXT, einspeisung_zaehler_l3_topic TEXT, eigenverbrauch_zaehler_l1_topic TEXT, eigenverbrauch_zaehler_l2_topic TEXT, eigenverbrauch_zaehler_l3_topic TEXT)'
    );
    db.run(
      'CREATE TABLE IF NOT EXISTS stromverbrauch_aggregation (id INTEGER PRIMARY KEY CHECK (id = 1), week_offset REAL NOT NULL DEFAULT 0, month_offset REAL NOT NULL DEFAULT 0, year_offset REAL NOT NULL DEFAULT 0, previous_year_total REAL NOT NULL DEFAULT 0, last_today_value REAL NOT NULL DEFAULT 0, last_rollover_date TEXT NOT NULL DEFAULT \'\', week_key TEXT NOT NULL DEFAULT \'\', month_key TEXT NOT NULL DEFAULT \'\', year_key TEXT NOT NULL DEFAULT \'\', week_import_offset REAL NOT NULL DEFAULT 0, week_export_offset REAL NOT NULL DEFAULT 0, year_import_offset REAL NOT NULL DEFAULT 0, year_export_offset REAL NOT NULL DEFAULT 0, previous_year_import_total REAL NOT NULL DEFAULT 0, previous_year_export_total REAL NOT NULL DEFAULT 0)'
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS stromverbrauch_counter_state (
        counter_key TEXT PRIMARY KEY,
        last_raw_value REAL,
        day_total REAL NOT NULL DEFAULT 0,
        last_day_key TEXT NOT NULL DEFAULT ''
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS pv_plants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        kw_peak REAL NOT NULL,
        efficiency REAL NOT NULL,
        orientation TEXT,
        tilt REAL NOT NULL,
        is_consumer_side INTEGER NOT NULL DEFAULT 0,
        cell_type TEXT NOT NULL,
        converter_type TEXT NOT NULL DEFAULT 'Direkt',
        power_topic TEXT,
        today_yield_topic TEXT,
        today_yield_unit TEXT NOT NULL DEFAULT 'kWh',
        auto_calibrate INTEGER NOT NULL DEFAULT 0,
        sun_cutoff_morning REAL NOT NULL DEFAULT 10,
        sun_cutoff_evening REAL NOT NULL DEFAULT 10
      )`
    );
    // Selbstkalibrierung: je Anlage und 15-Minuten-Bucket des Tages (0..95) ein
    // langsam nachgeführter Kalibrierfaktor (Default 1.0). Das abgeschlossene
    // 15-min-Fenster wird gegen die Open-Meteo-Strahlung desselben Fensters
    // verglichen; der Faktor wird auf den neuen Bucket übernommen. window_minutes
    // dokumentiert die Fensterbreite und dient als Migrations-Marker.
    db.run(
      `CREATE TABLE IF NOT EXISTS pv_calibration_buckets (
        plant_id INTEGER NOT NULL,
        bucket INTEGER NOT NULL,
        factor REAL NOT NULL DEFAULT 1.0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER,
        window_minutes INTEGER NOT NULL DEFAULT 15,
        PRIMARY KEY (plant_id, bucket),
        FOREIGN KEY (plant_id) REFERENCES pv_plants(id) ON DELETE CASCADE
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS pv_aggregation (
        plant_id INTEGER PRIMARY KEY,
        week_offset REAL NOT NULL DEFAULT 0,
        total_offset REAL NOT NULL DEFAULT 0,
        last_today_value REAL NOT NULL DEFAULT 0,
        last_rollover_date TEXT NOT NULL DEFAULT '',
        week_key TEXT NOT NULL DEFAULT '',
        last_counter_raw REAL,
        counter_total_kwh REAL,
        day_key TEXT,
        day_start_kwh REAL,
        FOREIGN KEY (plant_id) REFERENCES pv_plants(id) ON DELETE CASCADE
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS pv_summary_aggregation (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        week_offset REAL NOT NULL DEFAULT 0,
        year_offset REAL NOT NULL DEFAULT 0,
        previous_year_total REAL NOT NULL DEFAULT 0,
        last_today_value REAL NOT NULL DEFAULT 0,
        last_rollover_date TEXT NOT NULL DEFAULT '',
        week_key TEXT NOT NULL DEFAULT '',
        year_key TEXT NOT NULL DEFAULT ''
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS outputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        target_topic TEXT NOT NULL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS dashboard_tabs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS dashboard_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        width TEXT NOT NULL DEFAULT 'full',
        position INTEGER NOT NULL DEFAULT 0,
        tab_id INTEGER
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS dashboard_widgets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'value',
        config TEXT,
        group_id INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        tab_id INTEGER
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS sun_intensity_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recorded_at INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        intensity REAL NOT NULL,
        day_average_eligible INTEGER NOT NULL DEFAULT 1
      )`
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_sun_intensity_recorded_at ON sun_intensity_samples (recorded_at)'
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_sun_intensity_day_key ON sun_intensity_samples (day_key)'
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS modules (
        key TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS batterie_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        soc_topic TEXT NOT NULL DEFAULT '',
        power_topic TEXT NOT NULL DEFAULT '',
        voltage_topic TEXT NOT NULL DEFAULT '',
        temperatur_topic TEXT NOT NULL DEFAULT '',
        min_soc_topic TEXT NOT NULL DEFAULT '',
        remote_topic TEXT NOT NULL DEFAULT '',
        min_soc INTEGER NOT NULL DEFAULT 20,
        capacity_ah REAL NOT NULL DEFAULT 200,
        battery_type TEXT NOT NULL DEFAULT 'lifepo4',
        cell_count INTEGER NOT NULL DEFAULT 16,
        lower_voltage REAL NOT NULL DEFAULT 44.8,
        upper_voltage REAL NOT NULL DEFAULT 55.2,
        charge_efficiency REAL NOT NULL DEFAULT 95,
        discharge_efficiency REAL NOT NULL DEFAULT 95
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS battery_daily_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        day_key TEXT NOT NULL DEFAULT '',
        charged_today INTEGER NOT NULL DEFAULT 0
      )`
    );
    // Kumulierte Akku-Lade-/Entladeenergie per Leistungsintegration (kein
    // eigener Energiezähler am Hausakku). Dient dazu, den Jahres-Eigenverbrauch
    // (PV+Import-Export) um die Netto-Akkuladung zu bereinigen – die fließt
    // sonst als scheinbarer Mehrverbrauch in die Prognosebasis ein, obwohl sie
    // später beim Entladen ohnehin schon einmal gezählt wird.
    db.run(
      `CREATE TABLE IF NOT EXISTS battery_energy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_power_ts INTEGER,
        day_charge_kwh REAL NOT NULL DEFAULT 0,
        day_discharge_kwh REAL NOT NULL DEFAULT 0,
        week_charge_offset REAL NOT NULL DEFAULT 0,
        week_discharge_offset REAL NOT NULL DEFAULT 0,
        month_charge_offset REAL NOT NULL DEFAULT 0,
        month_discharge_offset REAL NOT NULL DEFAULT 0,
        year_charge_offset REAL NOT NULL DEFAULT 0,
        year_discharge_offset REAL NOT NULL DEFAULT 0,
        previous_year_charge_total REAL NOT NULL DEFAULT 0,
        previous_year_discharge_total REAL NOT NULL DEFAULT 0,
        last_rollover_date TEXT NOT NULL DEFAULT '',
        week_key TEXT NOT NULL DEFAULT '',
        month_key TEXT NOT NULL DEFAULT '',
        year_key TEXT NOT NULL DEFAULT ''
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS prognosis_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        charge_efficiency REAL NOT NULL DEFAULT 95,
        discharge_efficiency REAL NOT NULL DEFAULT 95,
        history_days INTEGER NOT NULL DEFAULT 28,
        behavior_model TEXT NOT NULL DEFAULT 'grid_parallel',
        behavior_active INTEGER NOT NULL DEFAULT 0,
        wallbox_learning_version INTEGER NOT NULL DEFAULT 1,
        self_count_guard_percent REAL NOT NULL DEFAULT 25,
        self_count_guard_min_kwh REAL NOT NULL DEFAULT 0.2
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS prognosis_daily_consumption (
        day_key TEXT PRIMARY KEY,
        consumption_kwh REAL NOT NULL DEFAULT 0,
        raw_consumption_kwh REAL NOT NULL DEFAULT 0,
        max_temperature REAL,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS prognosis_hourly_consumption (
        day_key TEXT NOT NULL,
        hour INTEGER NOT NULL,
        consumption_kwh REAL NOT NULL DEFAULT 0,
        primary_kwh REAL,
        self_kwh REAL,
        reconciled INTEGER NOT NULL DEFAULT 0,
        incomplete INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day_key, hour)
      )`
    );
    // Gesundheit der Verbrauchserfassung: Zeitpunkt des letzten Samples MIT
    // verbraucherseitigen Daten. Reißt der Abstand über eine volle Stunde, gelten
    // die dazwischenliegenden Stunden als „unvollständig" (Vortageswert, ausgegraut).
    db.run(
      `CREATE TABLE IF NOT EXISTS prognosis_sampling_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_ok_ts INTEGER
      )`
    );
    db.run(
      'CREATE INDEX IF NOT EXISTS idx_prognosis_daily_completed ON prognosis_daily_consumption (completed, day_key)'
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS grid_control_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        grid_command_topic TEXT NOT NULL DEFAULT '',
        feed_in_command_topic TEXT NOT NULL DEFAULT '',
        temperature_warning_topic TEXT NOT NULL DEFAULT '',
        temperature_warning_value TEXT NOT NULL DEFAULT '1',
        warning_text_topic TEXT NOT NULL DEFAULT '',
        warning_active_topic TEXT NOT NULL DEFAULT '',
        soc_enabled INTEGER NOT NULL DEFAULT 0,
        voltage_enabled INTEGER NOT NULL DEFAULT 0,
        temperature_enabled INTEGER NOT NULL DEFAULT 0,
        feed_in_allowed INTEGER NOT NULL DEFAULT 0,
        soc_lower_offset INTEGER NOT NULL DEFAULT 0,
        soc_upper_offset INTEGER NOT NULL DEFAULT 5,
        soc_hysteresis INTEGER NOT NULL DEFAULT 2,
        voltage_hysteresis REAL NOT NULL DEFAULT 0.5,
        grid_frequency_l1_topic TEXT NOT NULL DEFAULT '',
        grid_frequency_l2_topic TEXT NOT NULL DEFAULT '',
        grid_frequency_l3_topic TEXT NOT NULL DEFAULT '',
        grid_detection_seconds INTEGER NOT NULL DEFAULT 30,
        load_enabled INTEGER NOT NULL DEFAULT 0,
        load_off_delay_seconds INTEGER NOT NULL DEFAULT 30,
        load_shed_max_l1 REAL,
        load_shed_max_l2 REAL,
        load_shed_max_l3 REAL,
        load_on_l1 REAL,
        load_on_l2 REAL,
        load_on_l3 REAL,
        load_off_l1 REAL,
        load_off_l2 REAL,
        load_off_l3 REAL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS grid_control_runtime (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        load_active INTEGER NOT NULL DEFAULT 0,
        load_off_since INTEGER NOT NULL DEFAULT 0,
        initialized INTEGER NOT NULL DEFAULT 0
      )`
    );
    db.run('INSERT OR IGNORE INTO grid_control_runtime (id) VALUES (1)');
    db.run(
      `CREATE TABLE IF NOT EXISTS operating_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        operating_level INTEGER NOT NULL DEFAULT 2,
        emergency_mode INTEGER NOT NULL DEFAULT 0,
        autark INTEGER NOT NULL DEFAULT 1,
        autark_day_key TEXT NOT NULL DEFAULT '',
        autark_days_count INTEGER NOT NULL DEFAULT 0,
        autark_days_year TEXT NOT NULL DEFAULT '',
        autark_counted_day_key TEXT NOT NULL DEFAULT '',
        autark_days_topic TEXT NOT NULL DEFAULT '',
        autark_days_previous_year_count INTEGER NOT NULL DEFAULT 0,
        autark_days_previous_year TEXT NOT NULL DEFAULT '',
        autark_days_previous_year_topic TEXT NOT NULL DEFAULT ''
      )`
    );
    db.run(
      // Vollständiges Schema: frische DBs erhalten alle Spalten sofort, damit der
      // seedPoolConfig-INSERT nicht gegen die (asynchron laufende) Migration
      // rennt. migratePoolConfig bleibt als Upgrade-Pfad für alte DBs, die nur die
      // Basisspalten haben (CREATE IF NOT EXISTS ist dort ein No-op).
      `CREATE TABLE IF NOT EXISTS pool_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        temperature_topic TEXT NOT NULL DEFAULT '',
        pump_status_topic TEXT NOT NULL DEFAULT '',
        pump_command_topic TEXT NOT NULL DEFAULT '',
        ph_topic TEXT NOT NULL DEFAULT '',
        chlor_topic TEXT NOT NULL DEFAULT '',
        solar_pump_status_topic TEXT NOT NULL DEFAULT '',
        solar_pump_command_topic TEXT NOT NULL DEFAULT '',
        solar_pump_priority INTEGER NOT NULL DEFAULT 2,
        solar_pump_phase TEXT NOT NULL DEFAULT 'l1',
        solar_pump_max_temp REAL,
        solar_pump_temp_on_seconds INTEGER NOT NULL DEFAULT 30,
        solar_pump_temp_pause_minutes INTEGER NOT NULL DEFAULT 30,
        solar_pump_temp_use_filter INTEGER NOT NULL DEFAULT 0,
        filter_pump_status_topic TEXT NOT NULL DEFAULT '',
        filter_pump_command_topic TEXT NOT NULL DEFAULT '',
        filter_pump_priority INTEGER NOT NULL DEFAULT 4,
        filter_pump_phase TEXT NOT NULL DEFAULT 'l1',
        filter_pump_follow_solar INTEGER NOT NULL DEFAULT 0,
        filter_time_1_start TEXT NOT NULL DEFAULT '',
        filter_time_1_end TEXT NOT NULL DEFAULT '',
        filter_time_2_start TEXT NOT NULL DEFAULT '',
        filter_time_2_end TEXT NOT NULL DEFAULT '',
        filter_time_3_start TEXT NOT NULL DEFAULT '',
        filter_time_3_end TEXT NOT NULL DEFAULT '',
        filter_battery_enabled INTEGER NOT NULL DEFAULT 0,
        filter_battery_soc INTEGER NOT NULL DEFAULT 80,
        filter_battery_soc_topic TEXT NOT NULL DEFAULT '',
        solar_pump_rated_power_w REAL,
        filter_pump_rated_power_w REAL
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS pool_energy_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        solar_power_w REAL NOT NULL DEFAULT 0,
        filter_power_w REAL NOT NULL DEFAULT 0,
        solar_samples TEXT NOT NULL DEFAULT '[]',
        filter_samples TEXT NOT NULL DEFAULT '[]',
        last_house_power_w REAL,
        last_solar_on INTEGER NOT NULL DEFAULT 0,
        last_filter_on INTEGER NOT NULL DEFAULT 0,
        last_sample_ts INTEGER,
        day_kwh REAL NOT NULL DEFAULT 0,
        year_kwh REAL NOT NULL DEFAULT 0,
        previous_year_kwh REAL NOT NULL DEFAULT 0,
        day_key TEXT NOT NULL DEFAULT '',
        year_key TEXT NOT NULL DEFAULT '',
        updated_at INTEGER
      )`
    );
    // Optionales Modul Wallbox: je Wallbox eine Zeile. Topics steuern/messen die
    // Box, die Prioritäten gelten je Lademodus (1=Privat, 2=Beruflich, 3=Immer voll).
    db.run(
      `CREATE TABLE IF NOT EXISTS wallboxes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        max_power_w REAL NOT NULL DEFAULT 11000,
        battery_capacity_kwh REAL NOT NULL DEFAULT 50,
        command_topic TEXT NOT NULL DEFAULT '',
        control_sync_topic TEXT NOT NULL DEFAULT '',
        status_topic TEXT NOT NULL DEFAULT '',
        power_topic TEXT NOT NULL DEFAULT '',
        power_unit TEXT NOT NULL DEFAULT 'W',
        counter_topic TEXT NOT NULL DEFAULT '',
        counter_unit TEXT NOT NULL DEFAULT 'kWh',
        setpoint_topic TEXT NOT NULL DEFAULT '',
        plugged_topic TEXT NOT NULL DEFAULT '',
        soc_topic TEXT NOT NULL DEFAULT '',
        mode_sync_topic TEXT NOT NULL DEFAULT '',
        mode INTEGER NOT NULL DEFAULT 1,
        priority_private INTEGER NOT NULL DEFAULT 5,
        priority_business INTEGER NOT NULL DEFAULT 3,
        priority_full INTEGER NOT NULL DEFAULT 4,
        load_shed_phase TEXT NOT NULL DEFAULT 'three_phase',
        min_charge_percent INTEGER NOT NULL DEFAULT 30,
        min_charge_business_percent INTEGER NOT NULL DEFAULT 100,
        business_days TEXT NOT NULL DEFAULT '',
        business_end_hour INTEGER NOT NULL DEFAULT 18,
        stall_timeout_seconds INTEGER NOT NULL DEFAULT 120,
        stall_power_w REAL NOT NULL DEFAULT 200,
        control_mode TEXT NOT NULL DEFAULT 'auto'
      )`
    );
    // Zähler-Roh-/Tageswert je Box (analog stromverbrauch_counter_state). Fehlt das
    // Zähler-Topic, wird day_total stattdessen aus der Leistung integriert.
    db.run(
      `CREATE TABLE IF NOT EXISTS wallbox_counter_state (
        wallbox_id INTEGER PRIMARY KEY,
        last_raw_value REAL,
        day_total REAL NOT NULL DEFAULT 0,
        last_day_key TEXT NOT NULL DEFAULT '',
        plugged_energy_start REAL,
        last_power_ts INTEGER,
        FOREIGN KEY (wallbox_id) REFERENCES wallboxes(id) ON DELETE CASCADE
      )`
    );
    // Historische Summen je Box inkl. Monat (analog stromverbrauch_aggregation).
    db.run(
      `CREATE TABLE IF NOT EXISTS wallbox_summary_state (
        wallbox_id INTEGER PRIMARY KEY,
        week_offset REAL NOT NULL DEFAULT 0,
        month_offset REAL NOT NULL DEFAULT 0,
        year_offset REAL NOT NULL DEFAULT 0,
        previous_year_total REAL NOT NULL DEFAULT 0,
        last_rollover_date TEXT NOT NULL DEFAULT '',
        week_key TEXT NOT NULL DEFAULT '',
        month_key TEXT NOT NULL DEFAULT '',
        year_key TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (wallbox_id) REFERENCES wallboxes(id) ON DELETE CASCADE
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS wallbox_daily_consumption (
        wallbox_id INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        consumption_kwh REAL NOT NULL DEFAULT 0,
        completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (wallbox_id, day_key),
        FOREIGN KEY (wallbox_id) REFERENCES wallboxes(id) ON DELETE CASCADE
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS wallbox_hourly_consumption (
        wallbox_id INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        hour INTEGER NOT NULL,
        consumption_kwh REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (wallbox_id, day_key, hour),
        FOREIGN KEY (wallbox_id) REFERENCES wallboxes(id) ON DELETE CASCADE
      )`
    );
    db.run('CREATE INDEX IF NOT EXISTS idx_wallbox_daily_day ON wallbox_daily_consumption (day_key, completed)');
    // Messen + Schalten: frei anlegbare Gruppen (wie Dashboard-Gruppen) mit einer
    // Priorität, die zugeordnete Geräte optional übernehmen können.
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 4,
        position INTEGER NOT NULL DEFAULT 0,
        function_key TEXT NOT NULL DEFAULT '',
        offset_total_consumption INTEGER NOT NULL DEFAULT 1,
        parent_id INTEGER,
        meter_group INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL DEFAULT ''
      )`
    );
    // Messen + Schalten: je Gerät (Aktor) bis zu vier MQTT-Topics (schalten/status/
    // leistung/zähler). desired_on hält den persistenten Wunschzustand des Kachel-
    // Toggles; er wird immer über das Betriebslevel gegatet. use_group_priority = 1
    // ⇒ Gerät erhält die Priorität seiner Gruppe.
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_actors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        group_id INTEGER,
        position INTEGER NOT NULL DEFAULT 0,
        switch_topic TEXT NOT NULL DEFAULT '',
        remote_topic TEXT NOT NULL DEFAULT '',
        status_topic TEXT NOT NULL DEFAULT '',
        power_topic TEXT NOT NULL DEFAULT '',
        power_unit TEXT NOT NULL DEFAULT 'W',
        counter_topic TEXT NOT NULL DEFAULT '',
        counter_unit TEXT NOT NULL DEFAULT 'kWh',
        rated_power REAL,
        rated_power_unit TEXT NOT NULL DEFAULT 'W',
        priority INTEGER NOT NULL DEFAULT 4,
        use_group_priority INTEGER NOT NULL DEFAULT 0,
        desired_on INTEGER NOT NULL DEFAULT 0,
        always_on INTEGER NOT NULL DEFAULT 0,
        function_key TEXT NOT NULL DEFAULT '',
        load_shed_enabled INTEGER NOT NULL DEFAULT 0,
        load_shed_phase TEXT NOT NULL DEFAULT 'l1',
        switch_group_id INTEGER
      )`
    );
    // Ableitungszustand für „Leistung aus Zählerfortschritt": zuletzt gesehener
    // Zählerstand, Zeitpunkt des letzten Fortschritts und die daraus abgeleitete
    // Leistung. Bleibt der Fortschritt > 10 min aus, fällt die Leistung auf 0 W.
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_actor_state (
        actor_id INTEGER PRIMARY KEY,
        last_counter_raw REAL,
        last_progress_ts INTEGER,
        derived_power_w REAL,
        counter_total_kwh REAL,
        day_key TEXT,
        day_start_kwh REAL,
        year_key TEXT,
        year_start_kwh REAL,
        prev_year_kwh REAL,
        power_energy_kwh REAL,
        power_energy_day_start_kwh REAL,
        last_power_ts INTEGER,
        FOREIGN KEY (actor_id) REFERENCES mess_schalt_actors(id) ON DELETE CASCADE
      )`
    );
    // Schaltgruppen (Unterseite von Messen + Schalten): benannte Gruppen, deren
    // Schaltzustand sich aus den zugeordneten Geräten ableitet (an, sobald ein
    // Gerät an ist). Optionales Remote-Topic hält den Zustand bidirektional
    // synchron; switch_as_unit = 1 ⇒ jede Ein-/Ausschaltflanke zieht die
    // übrigen Geräte der Gruppe in denselben Zustand mit; timer_minutes > 0
    // schaltet die Gruppe nach der Laufzeit wieder aus.
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_switch_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        remote_topic TEXT NOT NULL DEFAULT '',
        switch_as_unit INTEGER NOT NULL DEFAULT 0,
        timer_minutes REAL NOT NULL DEFAULT 0
      )`
    );
    // Funktions-Statistik (Licht, Waschen, Warmwasser, Heizung / Klima, Kochen):
    // je Funktion und Stunde die integrierte Energie der zugeordneten Geräte plus
    // die energiegewichtete Außentemperatur der Stunde (Basis der Temperatur-Bucket-Profile
    // von Heizung / Klima).
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_function_hourly (
        function_key TEXT NOT NULL,
        day_key TEXT NOT NULL,
        hour INTEGER NOT NULL,
        consumption_kwh REAL NOT NULL DEFAULT 0,
        temperature REAL,
        PRIMARY KEY (function_key, day_key, hour)
      )`
    );
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_function_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_sample_ts INTEGER
      )`
    );
    // Heizung / Klima nach Außentemperatur: je 1-°C-Fenster bis zu 30 Messtage,
    // pro Tag UND Tagesstunde (0–23) die zeitgewichtete mittlere Leistung (W) bei
    // dieser Temperatur. Die Stunde ist nötig, weil der Heiz-/Kühlbedarf je Tageszeit
    // variiert (Kühlen v.a. abends, Heizen morgens zum Aufheizen stärker als abends).
    // Bewusst KEINE lange Historie – ein Fenster wird nur an Tagen belegt, an denen
    // diese Außentemperatur real auftrat (Sommer-Kühlkurve bleibt im Winter stehen).
    // Der Balken der Prognose-Datenbasis zeigt das 30-Tage-Mittel über alle 24 Stunden,
    // der Klick-Dialog die 24-Stunden-Kurve, die Markierungslinie den heutigen Wert.
    db.run(
      `CREATE TABLE IF NOT EXISTS mess_schalt_temperature_power (
        bucket INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        hour INTEGER NOT NULL DEFAULT 0,
        avg_power_w REAL NOT NULL DEFAULT 0,
        weight_seconds REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (bucket, day_key, hour)
      )`
    );
    // Energiefluss-Exporte: benannte, öffentlich abrufbare Live-Ansichten des
    // Energiefluss-Diagramms (Theme hell/dunkel). Der aus dem Namen abgeleitete
    // Slug bildet die Export-URL (/energiefluss/export/<slug>).
    db.run(
      `CREATE TABLE IF NOT EXISTS energiefluss_exports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT '',
        slug TEXT NOT NULL DEFAULT '',
        theme TEXT NOT NULL DEFAULT 'light'
      )`
    );
    // Adapter-Instanzen: je Zeile eine benannte Instanz eines Adapters (aus
    // /adapter/<adapter_id>). settings hält die instanzeigenen Einstellungen als
    // JSON. Es wird stets auf dieselben Adapterdateien zugegriffen.
    db.run(
      `CREATE TABLE IF NOT EXISTS adapter_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter_id TEXT NOT NULL,
        name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        settings TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL DEFAULT 0
      )`
    );
    // Letzter bekannter States-Katalog je Instanz (vom Adapter gemeldet). Dient
    // der States-Seite und dem State-Picker, auch wenn der Adapter gerade nicht
    // läuft. last_value ist nur eine Momentaufnahme; Live-Werte kommen aus dem Bus.
    db.run(
      `CREATE TABLE IF NOT EXISTS adapter_states (
        instance_id INTEGER NOT NULL,
        address TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL DEFAULT '',
        writable INTEGER NOT NULL DEFAULT 0,
        last_value TEXT,
        updated_at INTEGER,
        PRIMARY KEY (instance_id, address),
        FOREIGN KEY (instance_id) REFERENCES adapter_instances(id) ON DELETE CASCADE
      )`
    );
    // Historisierte, abgeschlossene Tageswerte einzelner Kennzahlen (PV-Ertrag,
    // Netzbezug, Eigenverbrauch) für die
    // Jahres-Statistik (Durchschnitt/Minimum/Maximum inkl. Datum) im
    // Wertekatalog. Wird je Kennzahl beim Tageswechsel der Quelle einmalig
    // geschrieben und danach nicht mehr verändert.
    db.run(
      `CREATE TABLE IF NOT EXISTS daily_metric_history (
        metric TEXT NOT NULL,
        day_key TEXT NOT NULL,
        value REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (metric, day_key)
      )`
    );

    seedUser(db);
    seedMqttConfig(db);
    migrateMqttConfig(db);
    seedStromverbrauchConfig(db);
    migrateStromverbrauchConfig(db);
    seedStromverbrauchAggregation(db);
    migrateStromverbrauchAggregation(db);
    seedPvSummaryAggregation(db);
    migratePvPlants(db);
    migratePvAggregation(db);
    migrateDashboardWidgets(db);
    migrateDashboardGroups(db);
    migrateSunIntensitySamples(db);
    migratePvCalibrationBuckets(db);
    migratePlaintextPassword(db);
    migrateUsers(db);
    migrateSessions(db);
    seedBatterieConfig(db);
    migrateBatterieConfig(db);
    seedPrognosisConfig(db);
    migratePrognosisDailyConsumption(db);
    migratePrognosisConfig(db);
    seedGridControlConfig(db);
    migrateGridControlConfig(db);
    seedOperatingState(db);
    seedPoolConfig(db);
    migratePoolConfig(db);
    migrateWallboxes(db);
    migrateMessSchaltActors(db);
    migrateMessSchaltTemperaturePower(db);
  });

  return db;
}

function seedPrognosisConfig(db) {
  db.run(
    `INSERT OR IGNORE INTO prognosis_config
      (id, charge_efficiency, discharge_efficiency, history_days)
     VALUES (1, 95, 95, 28)`
  );
}

function migratePrognosisDailyConsumption(db) {
  db.all('PRAGMA table_info(prognosis_daily_consumption)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('raw_consumption_kwh')) {
      db.run(
        'ALTER TABLE prognosis_daily_consumption ADD COLUMN raw_consumption_kwh REAL NOT NULL DEFAULT 0',
        // Frühere Samples enthalten nicht rekonstruierbare Batterieenergie.
        // Ein sauberer Neustart des Lernfensters ist genauer als Altwerte unter
        // falscher Bedeutung in die neuen Wochentagskurven zu übernehmen.
        () => db.run(
          'DELETE FROM prognosis_hourly_consumption',
          () => db.run('DELETE FROM prognosis_daily_consumption')
        )
      );
    }
    if (!existing.has('max_temperature')) {
      db.run('ALTER TABLE prognosis_daily_consumption ADD COLUMN max_temperature REAL');
    }
  });
  // Stundentabelle: Vergleichsserien für die abgehärtete Datenbasis.
  // primary_kwh = zähler-/bilanzbasierter Wert, self_kwh = aus der
  // Eigenverbrauch-Leistung integrierte Selbstzählung, reconciled = Guard gelaufen.
  db.all('PRAGMA table_info(prognosis_hourly_consumption)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('primary_kwh')) db.run('ALTER TABLE prognosis_hourly_consumption ADD COLUMN primary_kwh REAL');
    if (!existing.has('self_kwh')) db.run('ALTER TABLE prognosis_hourly_consumption ADD COLUMN self_kwh REAL');
    if (!existing.has('reconciled')) db.run('ALTER TABLE prognosis_hourly_consumption ADD COLUMN reconciled INTEGER NOT NULL DEFAULT 0');
    // incomplete = 1: Stunde konnte nicht sauber erfasst werden (Sampling-Lücke);
    // consumption_kwh wurde auf den Vortageswert gesetzt, Anzeige ausgegraut.
    if (!existing.has('incomplete')) db.run('ALTER TABLE prognosis_hourly_consumption ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0');
  });
}

function migratePrognosisConfig(db) {
  db.all('PRAGMA table_info(prognosis_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('behavior_model')) {
      db.run("ALTER TABLE prognosis_config ADD COLUMN behavior_model TEXT NOT NULL DEFAULT 'grid_parallel'");
    }
    if (!existing.has('behavior_active')) {
      db.run('ALTER TABLE prognosis_config ADD COLUMN behavior_active INTEGER NOT NULL DEFAULT 0');
    }
    if (!existing.has('wallbox_learning_version')) {
      db.run(
        'ALTER TABLE prognosis_config ADD COLUMN wallbox_learning_version INTEGER NOT NULL DEFAULT 0',
        () => db.run('DELETE FROM prognosis_hourly_consumption', () =>
          db.run('DELETE FROM prognosis_daily_consumption', () =>
            db.run('UPDATE prognosis_config SET wallbox_learning_version = 1 WHERE id = 1')
          )
        )
      );
    }
    // Guard-Schwellen Bilanz ↔ Selbstzählung (Modellparameter): relative
    // Schwelle in Prozent (Standard 25) und absolute Mindest-Abweichung in kWh
    // (Standard 0,2).
    if (!existing.has('self_count_guard_percent')) {
      db.run('ALTER TABLE prognosis_config ADD COLUMN self_count_guard_percent REAL NOT NULL DEFAULT 25');
    }
    if (!existing.has('self_count_guard_min_kwh')) {
      db.run('ALTER TABLE prognosis_config ADD COLUMN self_count_guard_min_kwh REAL NOT NULL DEFAULT 0.2');
    }
  });
}

// Erstinstallation: der erste Nutzer ist der Administrator. Er trägt immer alle
// Rechte (is_admin = 1) und kann nicht auf ein eingeschränktes Rollenmodell
// heruntergestuft werden.
function seedUser(db) {
  db.get('SELECT COUNT(*) AS cnt FROM users', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        "INSERT INTO users (name, password, role, is_admin, visible_pages) VALUES ('Administrator', ?, 'write', 1, NULL)",
        [hashPassword(config.DEFAULT_PASSWORD)]
      );
    }
  });
}

// Früher hatte die users-Tabelle nur id + password. Benutzerverwaltung ergänzt
// Name, Rolle, Admin-Flag und die je Nutzer sichtbaren Seiten. Der bestehende
// (einzige) Zugang wird dabei zum Administrator.
function migrateUsers(db) {
  db.all('PRAGMA table_info(users)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('name')) {
      db.run("ALTER TABLE users ADD COLUMN name TEXT NOT NULL DEFAULT 'Administrator'");
    }
    if (!existing.has('role')) {
      db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'write'");
    }
    if (!existing.has('is_admin')) {
      db.run('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
      // Bestehende Installation: der erste (bislang einzige) Nutzer wird Admin.
      db.run('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
    }
    if (!existing.has('visible_pages')) {
      db.run('ALTER TABLE users ADD COLUMN visible_pages TEXT');
    }
  });
}

// Sessions tragen nachträglich den zugehörigen Nutzer, damit Rechte je Session
// aufgelöst werden können. Bestehende Sessions ohne Bezug werden dem
// Administrator zugeordnet (nächster Login vergibt den echten Bezug ohnehin neu).
function migrateSessions(db) {
  db.all('PRAGMA table_info(sessions)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('user_id')) {
      db.run('ALTER TABLE sessions ADD COLUMN user_id INTEGER', () => {
        db.run('UPDATE sessions SET user_id = (SELECT MIN(id) FROM users WHERE is_admin = 1) WHERE user_id IS NULL');
      });
    }
  });
}

function seedMqttConfig(db) {
  db.get('SELECT COUNT(*) AS cnt FROM mqtt_config', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        `INSERT INTO mqtt_config
         (id, host, port, username, password, latitude, longitude, timezone, dst_enabled,
          outdoor_temperature_topic, clock_time_topic, clock_date_topic)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['localhost', 1883, '', '', null, null, 'Europe/Berlin', 1, '', '', '']
      );
    }
  });
}

function migrateMqttConfig(db) {
  db.all('PRAGMA table_info(mqtt_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    const additions = [
      { name: 'latitude', sql: 'ALTER TABLE mqtt_config ADD COLUMN latitude REAL' },
      { name: 'longitude', sql: 'ALTER TABLE mqtt_config ADD COLUMN longitude REAL' },
      { name: 'timezone', sql: "ALTER TABLE mqtt_config ADD COLUMN timezone TEXT" },
      { name: 'dst_enabled', sql: 'ALTER TABLE mqtt_config ADD COLUMN dst_enabled INTEGER NOT NULL DEFAULT 1' },
      { name: 'outdoor_temperature_topic', sql: 'ALTER TABLE mqtt_config ADD COLUMN outdoor_temperature_topic TEXT' },
      { name: 'clock_time_topic', sql: 'ALTER TABLE mqtt_config ADD COLUMN clock_time_topic TEXT' },
      { name: 'clock_date_topic', sql: 'ALTER TABLE mqtt_config ADD COLUMN clock_date_topic TEXT' },
    ];

    for (const addition of additions) {
      if (!existing.has(addition.name)) db.run(addition.sql);
    }
  });
}

function seedStromverbrauchConfig(db) {
  db.get('SELECT COUNT(*) AS cnt FROM stromverbrauch_config', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        `INSERT INTO stromverbrauch_config
         (id, current_topic, eigenverbrauch_l1_topic, eigenverbrauch_l2_topic, eigenverbrauch_l3_topic,
          netzbezug_l1_topic, netzbezug_l2_topic, netzbezug_l3_topic, today_topic,
          netzbezug_zaehler_l1_topic, netzbezug_zaehler_l2_topic, netzbezug_zaehler_l3_topic,
          einspeisung_zaehler_l1_topic, einspeisung_zaehler_l2_topic, einspeisung_zaehler_l3_topic)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['', '', '', '', '', '', '', '', '', '', '', '', '', '']
      );
    }
  });
}

function migrateStromverbrauchConfig(db) {
  db.all('PRAGMA table_info(stromverbrauch_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    const neededColumns = [
      'eigenverbrauch_l1_topic',
      'eigenverbrauch_l2_topic',
      'eigenverbrauch_l3_topic',
      'netzbezug_l1_topic',
      'netzbezug_l2_topic',
      'netzbezug_l3_topic',
      'netzbezug_zaehler_l1_topic',
      'netzbezug_zaehler_l2_topic',
      'netzbezug_zaehler_l3_topic',
      'einspeisung_zaehler_l1_topic',
      'einspeisung_zaehler_l2_topic',
      'einspeisung_zaehler_l3_topic',
      'eigenverbrauch_zaehler_l1_topic',
      'eigenverbrauch_zaehler_l2_topic',
      'eigenverbrauch_zaehler_l3_topic',
    ];

    for (const column of neededColumns) {
      if (!existing.has(column)) {
        db.run(`ALTER TABLE stromverbrauch_config ADD COLUMN ${column} TEXT`);
      }
    }
  });
}


function seedStromverbrauchAggregation(db) {
  db.get('SELECT COUNT(*) AS cnt FROM stromverbrauch_aggregation', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        `INSERT INTO stromverbrauch_aggregation
         (id, week_offset, month_offset, year_offset, previous_year_total, last_today_value, last_rollover_date, week_key, month_key, year_key)
         VALUES (1, 0, 0, 0, 0, 0, '', '', '', '')`
      );
    }
  });
}

function migrateStromverbrauchAggregation(db) {
  db.all('PRAGMA table_info(stromverbrauch_aggregation)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    const additions = [
      { name: 'year_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN year_offset REAL NOT NULL DEFAULT 0' },
      { name: 'previous_year_total', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN previous_year_total REAL NOT NULL DEFAULT 0' },
      { name: 'year_key', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN year_key TEXT NOT NULL DEFAULT \'\'' },
      { name: 'week_import_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN week_import_offset REAL NOT NULL DEFAULT 0' },
      { name: 'week_export_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN week_export_offset REAL NOT NULL DEFAULT 0' },
      { name: 'week_self_consumption_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN week_self_consumption_offset REAL NOT NULL DEFAULT 0' },
      { name: 'year_import_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN year_import_offset REAL NOT NULL DEFAULT 0' },
      { name: 'year_export_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN year_export_offset REAL NOT NULL DEFAULT 0' },
      { name: 'year_self_consumption_offset', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN year_self_consumption_offset REAL NOT NULL DEFAULT 0' },
      { name: 'previous_year_import_total', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN previous_year_import_total REAL NOT NULL DEFAULT 0' },
      { name: 'previous_year_export_total', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN previous_year_export_total REAL NOT NULL DEFAULT 0' },
      { name: 'previous_year_self_consumption_total', sql: 'ALTER TABLE stromverbrauch_aggregation ADD COLUMN previous_year_self_consumption_total REAL NOT NULL DEFAULT 0' },
    ];

    for (const addition of additions) {
      if (!existing.has(addition.name)) db.run(addition.sql);
    }
  });
}

// PV-Anlagen erhielten nachträglich den Konverter-/Reglertyp. Bestehende Zeilen
// bekommen 'Direkt' (kein zusätzlicher Geräte-Wirkungsgrad), bis der Typ je
// Anlage gesetzt wird.
function migratePvPlants(db) {
  db.all('PRAGMA table_info(pv_plants)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('converter_type')) {
      db.run("ALTER TABLE pv_plants ADD COLUMN converter_type TEXT NOT NULL DEFAULT 'Direkt'");
    }
    if (!existing.has('auto_calibrate')) {
      db.run('ALTER TABLE pv_plants ADD COLUMN auto_calibrate INTEGER NOT NULL DEFAULT 0');
    }
    if (!existing.has('sun_cutoff_morning')) {
      db.run('ALTER TABLE pv_plants ADD COLUMN sun_cutoff_morning REAL NOT NULL DEFAULT 10');
    }
    if (!existing.has('sun_cutoff_evening')) {
      db.run('ALTER TABLE pv_plants ADD COLUMN sun_cutoff_evening REAL NOT NULL DEFAULT 10');
    }
    if (!existing.has('today_yield_unit')) {
      db.run("ALTER TABLE pv_plants ADD COLUMN today_yield_unit TEXT NOT NULL DEFAULT 'kWh'");
    }
  });
}

// Ertragszähler je PV-Anlage: Das Ertrags-Topic ist ein ROHZÄHLER (kumulativer
// Zählerstand), aus dem – wie bei allen anderen Zählertopics – nur die Deltas
// intern fortgeschrieben werden (counter_total_kwh) und „heute" sich als
// Fortschritt seit dem Tagesstart (day_start_kwh) ergibt. Früher wurde der
// Rohwert direkt als Tagesertrag genommen; ein Topic-Wechsel schrieb dann den
// gesamten Zählerstand als heutigen Ertrag. Bestands-DBs bekommen die Spalten
// nachgerüstet; die Baselines bleiben leer und werden beim ersten Tick gesetzt
// (ohne Sprung), sodass der Ertrag bei 0 startet.
function migratePvAggregation(db) {
  db.all('PRAGMA table_info(pv_aggregation)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('last_counter_raw')) {
      db.run('ALTER TABLE pv_aggregation ADD COLUMN last_counter_raw REAL');
    }
    if (!existing.has('counter_total_kwh')) {
      db.run('ALTER TABLE pv_aggregation ADD COLUMN counter_total_kwh REAL');
    }
    if (!existing.has('day_key')) {
      db.run('ALTER TABLE pv_aggregation ADD COLUMN day_key TEXT');
    }
    if (!existing.has('day_start_kwh')) {
      db.run('ALTER TABLE pv_aggregation ADD COLUMN day_start_kwh REAL');
      // Nur beim erstmaligen Einführen der Delta-Zählung: den zuletzt (per altem
      // Verfahren als Rohwert) erfassten „heutigen" Gesamtertrag verwerfen, damit
      // ein fälschlich als Ertrag übernommener Zählerstand nicht stehen bleibt.
      // Woche/Jahr-Offsets bleiben unberührt (dort steckt ggf. Reales); der
      // nächste Tageswechsel schreibt dann korrekt ab 0 fort.
      db.run("UPDATE pv_summary_aggregation SET last_today_value = 0 WHERE id = 1");
    }
  });
}

function seedPvSummaryAggregation(db) {
  db.get('SELECT COUNT(*) AS cnt FROM pv_summary_aggregation', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        `INSERT INTO pv_summary_aggregation
         (id, week_offset, year_offset, previous_year_total, last_today_value, last_rollover_date, week_key, year_key)
         VALUES (1, 0, 0, 0, 0, '', '', '')`
      );
    }
  });
}

// Frühe Dashboard-Widgets hatten nur source_id. Gruppen-Zuordnung und Position
// werden bei Bedarf nachgerüstet.
function migrateDashboardWidgets(db) {
  db.all('PRAGMA table_info(dashboard_widgets)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('group_id')) {
      db.run('ALTER TABLE dashboard_widgets ADD COLUMN group_id INTEGER');
    }
    if (!existing.has('position')) {
      db.run('ALTER TABLE dashboard_widgets ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    }
    // Widgets erhielten nachträglich einen Typ (value/info) und eine freie
    // Konfiguration (JSON, z. B. die gewählten Felder der Info-Kachel).
    if (!existing.has('type')) {
      db.run("ALTER TABLE dashboard_widgets ADD COLUMN type TEXT NOT NULL DEFAULT 'value'");
    }
    if (!existing.has('config')) {
      db.run('ALTER TABLE dashboard_widgets ADD COLUMN config TEXT');
    }
    // Dashboard-Tabs: gruppenlose Widgets tragen ihre Tab-Zuordnung selbst
    // (Widgets in Gruppen erben den Tab der Gruppe). NULL = Standard-Tab.
    if (!existing.has('tab_id')) {
      db.run('ALTER TABLE dashboard_widgets ADD COLUMN tab_id INTEGER');
    }
  });
}

// Gruppen erhielten nachträglich Breite und Sortier-Position.
function migrateDashboardGroups(db) {
  db.all('PRAGMA table_info(dashboard_groups)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('width')) {
      db.run("ALTER TABLE dashboard_groups ADD COLUMN width TEXT NOT NULL DEFAULT 'full'");
    }
    if (!existing.has('position')) {
      db.run('ALTER TABLE dashboard_groups ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    }
    // Dashboard-Tabs: jede Gruppe gehört zu genau einem Tab. NULL = Standard-Tab.
    if (!existing.has('tab_id')) {
      db.run('ALTER TABLE dashboard_groups ADD COLUMN tab_id INTEGER');
    }
  });
}

// Umstellung des Kalibrier-Bucket-Modells von 10 auf 15 Minuten: Die bisherigen
// 10-min-Buckets (0..143) sind im 15-min-Raster (0..95) nicht mehr gültig und
// beziehen sich zudem auf eine andere Vergleichsgröße — sie werden daher einmalig
// verworfen. Fehlt die Spalte window_minutes, ist es eine Alt-Datenbank: löschen
// und Spalte ergänzen (läuft so genau einmal).
function migratePvCalibrationBuckets(db) {
  db.all('PRAGMA table_info(pv_calibration_buckets)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('window_minutes')) {
      db.run('DELETE FROM pv_calibration_buckets');
      db.run('ALTER TABLE pv_calibration_buckets ADD COLUMN window_minutes INTEGER NOT NULL DEFAULT 15');
    }
  });
}

function migrateSunIntensitySamples(db) {
  db.all('PRAGMA table_info(sun_intensity_samples)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    if (!existing.has('day_average_eligible')) {
      db.run(
        'ALTER TABLE sun_intensity_samples ADD COLUMN day_average_eligible INTEGER NOT NULL DEFAULT 1'
      );
    }
  });
}

// Bestehende Datenbanken speicherten das Passwort im Klartext. Beim Start
// wird ein noch ungehashter Wert einmalig in einen scrypt-Hash überführt.
function migratePlaintextPassword(db) {
  db.get('SELECT id, password FROM users LIMIT 1', (err, row) => {
    if (err || !row || isHashed(row.password)) return;
    db.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(row.password), row.id]);
  });
}

function seedBatterieConfig(db) {
  db.get('SELECT COUNT(*) AS cnt FROM batterie_config', (err, row) => {
    if (!err && row.cnt === 0) {
      db.run(
        `INSERT INTO batterie_config (id, soc_topic, power_topic, voltage_topic, temperatur_topic)
         VALUES (1, '', '', '', '')`
      );
    }
  });
}

function migrateBatterieConfig(db) {
  db.all('PRAGMA table_info(batterie_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    const additions = [
      { name: 'min_soc_topic', sql: "ALTER TABLE batterie_config ADD COLUMN min_soc_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'remote_topic', sql: "ALTER TABLE batterie_config ADD COLUMN remote_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'min_soc', sql: 'ALTER TABLE batterie_config ADD COLUMN min_soc INTEGER NOT NULL DEFAULT 20' },
      { name: 'capacity_ah', sql: 'ALTER TABLE batterie_config ADD COLUMN capacity_ah REAL NOT NULL DEFAULT 200' },
      { name: 'battery_type', sql: "ALTER TABLE batterie_config ADD COLUMN battery_type TEXT NOT NULL DEFAULT 'lifepo4'" },
      { name: 'cell_count', sql: 'ALTER TABLE batterie_config ADD COLUMN cell_count INTEGER NOT NULL DEFAULT 16' },
      { name: 'lower_voltage', sql: 'ALTER TABLE batterie_config ADD COLUMN lower_voltage REAL NOT NULL DEFAULT 44.8' },
      { name: 'upper_voltage', sql: 'ALTER TABLE batterie_config ADD COLUMN upper_voltage REAL NOT NULL DEFAULT 55.2' },
      { name: 'charge_efficiency', sql: 'ALTER TABLE batterie_config ADD COLUMN charge_efficiency REAL NOT NULL DEFAULT 95' },
      { name: 'discharge_efficiency', sql: 'ALTER TABLE batterie_config ADD COLUMN discharge_efficiency REAL NOT NULL DEFAULT 95' },
    ];
    for (const addition of additions) {
      if (!existing.has(addition.name)) {
        db.run(addition.sql, () => {
          if (addition.name === 'capacity_ah') {
            // Frühere Prognose-Konfiguration war in kWh. Beim einmaligen Upgrade
            // auf Ah anhand der Nennspannung verlustarm übernehmen.
            db.run(
              `UPDATE batterie_config
                  SET capacity_ah = COALESCE(
                    (SELECT battery_capacity_kwh FROM prognosis_config WHERE id = 1) * 1000 /
                    CASE battery_type
                      WHEN 'lifepo4' THEN cell_count * 3.2
                      WHEN 'liion' THEN cell_count * 3.7
                      WHEN 'leadacid' THEN cell_count * 2.0
                      ELSE (lower_voltage + upper_voltage) / 2
                    END,
                    capacity_ah
                  )
                WHERE id = 1`
            );
          } else if (addition.name === 'charge_efficiency' || addition.name === 'discharge_efficiency') {
            // Bestehende Werte von der Prognose- auf die Batteriekonfiguration
            // übernehmen; die alten Spalten bleiben für DB-Abwärtskompatibilität bestehen.
            db.run(
              `UPDATE batterie_config
                  SET ${addition.name} = COALESCE(
                    (SELECT ${addition.name} FROM prognosis_config WHERE id = 1),
                    ${addition.name}
                  )
                WHERE id = 1`
            );
          }
        });
      }
    }
  });
}

function seedGridControlConfig(db) {
  db.get('SELECT COUNT(*) AS cnt FROM grid_control_config', (err, row) => {
    if (!err && row && row.cnt === 0) {
      db.run('INSERT INTO grid_control_config (id) VALUES (1)');
    }
  });
}

function migrateGridControlConfig(db) {
  db.all('PRAGMA table_info(grid_control_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((row) => row.name));
    const additions = [
      { name: 'soc_hysteresis', sql: 'ALTER TABLE grid_control_config ADD COLUMN soc_hysteresis INTEGER NOT NULL DEFAULT 2' },
      { name: 'voltage_hysteresis', sql: 'ALTER TABLE grid_control_config ADD COLUMN voltage_hysteresis REAL NOT NULL DEFAULT 0.5' },
      { name: 'grid_frequency_l1_topic', sql: "ALTER TABLE grid_control_config ADD COLUMN grid_frequency_l1_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'grid_frequency_l2_topic', sql: "ALTER TABLE grid_control_config ADD COLUMN grid_frequency_l2_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'grid_frequency_l3_topic', sql: "ALTER TABLE grid_control_config ADD COLUMN grid_frequency_l3_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'grid_detection_seconds', sql: 'ALTER TABLE grid_control_config ADD COLUMN grid_detection_seconds INTEGER NOT NULL DEFAULT 30' },
      { name: 'load_enabled', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_enabled INTEGER NOT NULL DEFAULT 0' },
      { name: 'load_off_delay_seconds', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_off_delay_seconds INTEGER NOT NULL DEFAULT 30' },
      { name: 'load_shed_max_l1', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_shed_max_l1 REAL' },
      { name: 'load_shed_max_l2', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_shed_max_l2 REAL' },
      { name: 'load_shed_max_l3', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_shed_max_l3 REAL' },
      { name: 'load_on_l1', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_on_l1 REAL' },
      { name: 'load_on_l2', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_on_l2 REAL' },
      { name: 'load_on_l3', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_on_l3 REAL' },
      { name: 'load_off_l1', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_off_l1 REAL' },
      { name: 'load_off_l2', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_off_l2 REAL' },
      { name: 'load_off_l3', sql: 'ALTER TABLE grid_control_config ADD COLUMN load_off_l3 REAL' },
    ];
    const pending = additions.filter((addition) => !existing.has(addition.name));
    const addNext = (index) => {
      if (index < pending.length) {
        db.run(pending[index].sql, () => addNext(index + 1));
        return;
      }
      if (existing.has('grid_frequency_topic')) {
        db.run(
          "UPDATE grid_control_config SET grid_frequency_l1_topic = grid_frequency_topic WHERE grid_frequency_l1_topic = '' AND grid_frequency_topic <> ''",
          () => {}
        );
      }
    };
    addNext(0);
  });
}

// Wallboxen erhielten nachträglich konfigurierbare Stall-Erkennung (Zeitfenster und
// Leerlauf-Leistungsschwelle für den Ladestart-Neustart).
function migrateWallboxes(db) {
  db.all('PRAGMA table_info(wallboxes)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('stall_timeout_seconds')) {
      db.run('ALTER TABLE wallboxes ADD COLUMN stall_timeout_seconds INTEGER NOT NULL DEFAULT 120');
    }
    if (!existing.has('stall_power_w')) {
      db.run('ALTER TABLE wallboxes ADD COLUMN stall_power_w REAL NOT NULL DEFAULT 200');
    }
    if (!existing.has('load_shed_phase')) {
      db.run("ALTER TABLE wallboxes ADD COLUMN load_shed_phase TEXT NOT NULL DEFAULT 'three_phase'");
    }
    // Beruflich-Modus: eigener Mindest-Ladestand (Default 100 = bisheriges
    // Voll-Bereitstellen) und Uhrzeit, ab der vor einem freien Folgetag nur noch
    // die Privatregel gilt.
    if (!existing.has('min_charge_business_percent')) {
      db.run('ALTER TABLE wallboxes ADD COLUMN min_charge_business_percent INTEGER NOT NULL DEFAULT 100');
    }
    if (!existing.has('business_end_hour')) {
      db.run('ALTER TABLE wallboxes ADD COLUMN business_end_hour INTEGER NOT NULL DEFAULT 18');
    }
    // Manuelle Übersteuerung (auto/off/full) neustart-resistent persistieren.
    if (!existing.has('control_mode')) {
      db.run("ALTER TABLE wallboxes ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'auto'");
    }
    // Getrenntes Steuerung-Sync-Topic (an/aus): homeESS spiegelt hierauf den
    // Schaltzustand und erkennt externe Nutzerschaltungen; das Steuer-Topic bleibt
    // reiner Aktor (nur Schreiben, keine Bedienerkennung).
    if (!existing.has('control_sync_topic')) {
      db.run("ALTER TABLE wallboxes ADD COLUMN control_sync_topic TEXT NOT NULL DEFAULT ''");
    }
  });
}

// Messen-+-Schalten-Geräte erhielten desired_on bzw. always_on (Modus „Immer an")
// nachträglich; Altbestände ergänzen.
function migrateMessSchaltActors(db) {
  db.all('PRAGMA table_info(mess_schalt_actors)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('desired_on')) {
      db.run('ALTER TABLE mess_schalt_actors ADD COLUMN desired_on INTEGER NOT NULL DEFAULT 0');
    }
    if (!existing.has('remote_topic')) {
      db.run("ALTER TABLE mess_schalt_actors ADD COLUMN remote_topic TEXT NOT NULL DEFAULT ''");
    }
    if (!existing.has('always_on')) {
      db.run('ALTER TABLE mess_schalt_actors ADD COLUMN always_on INTEGER NOT NULL DEFAULT 0');
    }
    if (!existing.has('function_key')) {
      db.run("ALTER TABLE mess_schalt_actors ADD COLUMN function_key TEXT NOT NULL DEFAULT ''");
    }
    if (!existing.has('load_shed_enabled')) {
      db.run('ALTER TABLE mess_schalt_actors ADD COLUMN load_shed_enabled INTEGER NOT NULL DEFAULT 0');
    }
    if (!existing.has('load_shed_phase')) {
      db.run("ALTER TABLE mess_schalt_actors ADD COLUMN load_shed_phase TEXT NOT NULL DEFAULT 'l1'");
    }
    // Zuordnung zu einer Schaltgruppe (Unterseite Schaltgruppen, per Drag & Drop).
    if (!existing.has('switch_group_id')) {
      db.run('ALTER TABLE mess_schalt_actors ADD COLUMN switch_group_id INTEGER');
    }
    // Nennleistung für die virtuelle Zählung (Leistung/Energie aus Nennwert ×
    // Schaltzustand, nur wenn kein Leistungs- und kein Zähler-Topic gesetzt ist).
    if (!existing.has('rated_power')) {
      db.run('ALTER TABLE mess_schalt_actors ADD COLUMN rated_power REAL');
    }
    if (!existing.has('rated_power_unit')) {
      db.run("ALTER TABLE mess_schalt_actors ADD COLUMN rated_power_unit TEXT NOT NULL DEFAULT 'W'");
    }
  });
  db.all('PRAGMA table_info(mess_schalt_groups)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('function_key')) {
      db.run("ALTER TABLE mess_schalt_groups ADD COLUMN function_key TEXT NOT NULL DEFAULT ''");
    }
    if (!existing.has('offset_total_consumption')) {
      db.run('ALTER TABLE mess_schalt_groups ADD COLUMN offset_total_consumption INTEGER NOT NULL DEFAULT 1');
    }
    // Mehrschichtige Verbrauchsgruppen: parent_id verweist auf die übergeordnete
    // Gruppe (NULL = oberste Ebene). Verschachtelung wird per Drag & Drop gepflegt.
    if (!existing.has('parent_id')) {
      db.run('ALTER TABLE mess_schalt_groups ADD COLUMN parent_id INTEGER');
    }
    // Zählergruppe: eigene Geräte gelten als Zähler; der Gesamtverbrauch der
    // Gruppe ist damit fix und die Untergruppen werden davon abgezogen
    // („Sonstige Verbraucher dieser Gruppe").
    if (!existing.has('meter_group')) {
      db.run('ALTER TABLE mess_schalt_groups ADD COLUMN meter_group INTEGER NOT NULL DEFAULT 0');
    }
    // Freie Gruppenfarbe (Hex) für das Energiefluss-Diagramm; leer = Standard.
    if (!existing.has('color')) {
      db.run("ALTER TABLE mess_schalt_groups ADD COLUMN color TEXT NOT NULL DEFAULT ''");
    }
  });
  db.all('PRAGMA table_info(mess_schalt_switch_groups)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('timer_minutes')) {
      db.run('ALTER TABLE mess_schalt_switch_groups ADD COLUMN timer_minutes REAL NOT NULL DEFAULT 0');
    }
  });
  // Interner Zählerstand (Delta-Fortschreibung des Zähler-Topics). NULL heißt
  // „noch nie fortgeschrieben" – Altbestände übernehmen dann beim nächsten
  // Snapshot einmalig den aktuellen Rohwert als Startstand (nahtlose Anzeige).
  db.all('PRAGMA table_info(mess_schalt_actor_state)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (!existing.has('counter_total_kwh')) {
      db.run('ALTER TABLE mess_schalt_actor_state ADD COLUMN counter_total_kwh REAL');
    }
    // Tages-/Jahres-Baseline auf dem internen Zähler, plus abgeschlossener
    // Vorjahresverbrauch – für saubere Gruppen-Verbrauchssummen (Tag/Jahr/Vorjahr).
    // Aus dem Leistungs-Topic integrierte Energie (Tagesbasis) – unabhängig vom
    // Zähler-Topic. Dient als Plausibilitäts-Gegenprobe: Weicht der Zähler stark
    // von der aus der Live-Leistung integrierten Energie ab (z. B. Einheit Wh/kWh
    // vertauscht), wird am Gerät gewarnt.
    for (const [col, decl] of [
      ['day_key', 'TEXT'], ['day_start_kwh', 'REAL'],
      ['year_key', 'TEXT'], ['year_start_kwh', 'REAL'], ['prev_year_kwh', 'REAL'],
      ['power_energy_kwh', 'REAL'], ['power_energy_day_start_kwh', 'REAL'], ['last_power_ts', 'INTEGER'],
    ]) {
      if (!existing.has(col)) db.run(`ALTER TABLE mess_schalt_actor_state ADD COLUMN ${col} ${decl}`);
    }
  });
}

// Heizung / Klima nach Außentemperatur bekommt eine Tagesstunden-Dimension: aus
// (bucket, day_key) wird (bucket, day_key, hour). Alte DBs haben nur das
// Tagesmittel – dieses wird gleichmäßig auf alle 24 Stunden verteilt (die
// tatsächliche Stundenverteilung war bisher unbekannt) und verfeinert sich beim
// Weiterlernen. So bleibt die Balkenhöhe (Mittel über 24 Stunden) unverändert.
function migrateMessSchaltTemperaturePower(db) {
  db.all('PRAGMA table_info(mess_schalt_temperature_power)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    if (existing.has('hour')) return; // bereits migriert (bzw. frisch angelegt)
    db.serialize(() => {
      db.run('ALTER TABLE mess_schalt_temperature_power RENAME TO mess_schalt_temperature_power_old');
      db.run(
        `CREATE TABLE mess_schalt_temperature_power (
          bucket INTEGER NOT NULL,
          day_key TEXT NOT NULL,
          hour INTEGER NOT NULL DEFAULT 0,
          avg_power_w REAL NOT NULL DEFAULT 0,
          weight_seconds REAL NOT NULL DEFAULT 0,
          PRIMARY KEY (bucket, day_key, hour)
        )`
      );
      db.run(
        `INSERT INTO mess_schalt_temperature_power (bucket, day_key, hour, avg_power_w, weight_seconds)
         WITH RECURSIVE h(n) AS (SELECT 0 UNION ALL SELECT n + 1 FROM h WHERE n < 23)
         SELECT bucket, day_key, n, avg_power_w, weight_seconds / 24.0
           FROM mess_schalt_temperature_power_old, h`
      );
      db.run('DROP TABLE mess_schalt_temperature_power_old');
    });
  });
}

function seedOperatingState(db) {
  db.get('SELECT COUNT(*) AS cnt FROM operating_state', (err, row) => {
    if (!err && row && row.cnt === 0) db.run('INSERT INTO operating_state (id) VALUES (1)');
  });
}

function seedPoolConfig(db) {
  db.get('SELECT COUNT(*) AS cnt FROM pool_config', (err, row) => {
    if (!err && row && row.cnt === 0) {
      db.run(
        `INSERT INTO pool_config
         (id, temperature_topic, pump_status_topic, pump_command_topic, ph_topic, chlor_topic,
          solar_pump_status_topic, solar_pump_command_topic, solar_pump_priority, solar_pump_phase,
          filter_pump_status_topic, filter_pump_command_topic, filter_pump_priority, filter_pump_phase,
          filter_pump_follow_solar,
          filter_time_1_start, filter_time_1_end,
          filter_time_2_start, filter_time_2_end,
          filter_time_3_start, filter_time_3_end,
          filter_battery_enabled, filter_battery_soc, filter_battery_soc_topic)
         VALUES (1, '', '', '', '', '', '', '', 5, 'l1', '', '', 2, 'l1', 0, '', '', '', '', '', '', 0, 80, '')`
      );
    }
  });
}

function migratePoolConfig(db) {
  db.all('PRAGMA table_info(pool_config)', (err, rows) => {
    if (err || !Array.isArray(rows) || rows.length === 0) return;
    const existing = new Set(rows.map((r) => r.name));
    const additions = [
      { name: 'solar_pump_status_topic', sql: "ALTER TABLE pool_config ADD COLUMN solar_pump_status_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'solar_pump_command_topic', sql: "ALTER TABLE pool_config ADD COLUMN solar_pump_command_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'solar_pump_priority', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_priority INTEGER NOT NULL DEFAULT 2' },
      { name: 'solar_pump_phase', sql: "ALTER TABLE pool_config ADD COLUMN solar_pump_phase TEXT NOT NULL DEFAULT 'l1'" },
      { name: 'solar_pump_max_temp', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_max_temp REAL' },
      { name: 'solar_pump_temp_on_seconds', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_temp_on_seconds INTEGER NOT NULL DEFAULT 30' },
      { name: 'solar_pump_temp_pause_minutes', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_temp_pause_minutes INTEGER NOT NULL DEFAULT 30' },
      { name: 'solar_pump_temp_use_filter', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_temp_use_filter INTEGER NOT NULL DEFAULT 0' },
      { name: 'filter_pump_status_topic', sql: "ALTER TABLE pool_config ADD COLUMN filter_pump_status_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_pump_command_topic', sql: "ALTER TABLE pool_config ADD COLUMN filter_pump_command_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_pump_priority', sql: 'ALTER TABLE pool_config ADD COLUMN filter_pump_priority INTEGER NOT NULL DEFAULT 4' },
      { name: 'filter_pump_phase', sql: "ALTER TABLE pool_config ADD COLUMN filter_pump_phase TEXT NOT NULL DEFAULT 'l1'" },
      { name: 'filter_pump_follow_solar', sql: 'ALTER TABLE pool_config ADD COLUMN filter_pump_follow_solar INTEGER NOT NULL DEFAULT 0' },
      { name: 'filter_time_1_start', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_1_start TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_time_1_end', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_1_end TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_time_2_start', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_2_start TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_time_2_end', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_2_end TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_time_3_start', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_3_start TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_time_3_end', sql: "ALTER TABLE pool_config ADD COLUMN filter_time_3_end TEXT NOT NULL DEFAULT ''" },
      { name: 'filter_battery_enabled', sql: 'ALTER TABLE pool_config ADD COLUMN filter_battery_enabled INTEGER NOT NULL DEFAULT 0' },
      { name: 'filter_battery_soc', sql: 'ALTER TABLE pool_config ADD COLUMN filter_battery_soc INTEGER NOT NULL DEFAULT 80' },
      { name: 'filter_battery_soc_topic', sql: "ALTER TABLE pool_config ADD COLUMN filter_battery_soc_topic TEXT NOT NULL DEFAULT ''" },
      { name: 'solar_pump_rated_power_w', sql: 'ALTER TABLE pool_config ADD COLUMN solar_pump_rated_power_w REAL' },
      { name: 'filter_pump_rated_power_w', sql: 'ALTER TABLE pool_config ADD COLUMN filter_pump_rated_power_w REAL' },
    ];
    for (const addition of additions) {
      if (!existing.has(addition.name)) db.run(addition.sql);
    }
  });
}

module.exports = { openDatabase };
