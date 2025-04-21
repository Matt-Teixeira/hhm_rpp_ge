const queries = {
  GE_CT: `
    SELECT
      sys.id,
      sys.manufacturer,
      sys.modality,
      ac.debian_server_path,
      sites.time_zone_id,
      json_agg(
          json_build_object(
              'file_name',
              log.file_name,
              'dir_name',
              log.dir_name,
              'parsers',
              log.regex_models,
              'pg_tables',
              log.pg_tables
          )
      ) AS log_config
  FROM
      systems sys
      JOIN config.acquisition ac ON ac.system_id = sys.id
      JOIN config.log log ON log.system_id = sys.id
      JOIN sites ON sites.id = sys.site_id 
  WHERE
      sys.manufacturer = 'GE'
      AND sys.modality LIKE '%CT'
      AND ac.run_group = 1
  GROUP BY
      sys.id,
      ac.system_id,
      sites.time_zone_id;
        `,
  GE_CV: `
    SELECT
      sys.id,
      sys.manufacturer,
      sys.modality,
      sites.time_zone_id,
      ac.debian_server_path,
      json_agg(
          json_build_object(
              'system_id',
              log.system_id,
              'file_name',
              log.file_name,
              'dir_name',
              log.dir_name,
              'parsers',
              log.regex_models,
              'pg_tables',
              log.pg_tables
          )
      ) AS log_config
  FROM
      systems sys
      JOIN config.acquisition ac ON ac.system_id = sys.id
      JOIN config.log log ON log.system_id = sys.id
      JOIN sites ON sites.id = sys.site_id 
  WHERE
      sys.manufacturer = 'GE'
      AND sys.modality = 'CV/IR'
      AND ac.run_group = 1
  GROUP BY
      sys.id,
      ac.system_id,
      sites.time_zone_id;
        `,
  GE_MRI: `
    SELECT
      sys.id,
      sys.manufacturer,
      sys.modality,
      sites.time_zone_id,
      ac.debian_server_path,
      json_agg(
          json_build_object(
              'file_name',
              log.file_name,
              'dir_name',
              log.dir_name,
              'parsers',
              log.regex_models,
              'pg_tables',
              log.pg_tables
          )
      ) AS log_config
  FROM
      systems sys
      JOIN config.acquisition ac ON ac.system_id = sys.id
      JOIN config.log log ON log.system_id = sys.id
      JOIN sites ON sites.id = sys.site_id 
  WHERE
      sys.manufacturer = 'GE'
      AND sys.modality = 'MRI'
      AND ac.run_group = 1
      AND sys.id = 'SME01123'
  GROUP BY
      sys.id,
      ac.system_id,
      sites.time_zone_id;
      `
};

module.exports = queries;
