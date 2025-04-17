const ge_regex = {
  test: {
    for_box: /|/,
    for_exception_class: /Exception\sClass\s?:/,
    for_task_id: /Task\sID:/
  },
  mri: {
    gesys: {
      block: /SR\s(\d+).*?EN\s\1/gs,
      sub_block:
        /(?:SR\s(?<sr>.+?)[\n\r])(?<epoch>.+?)\s(?<record_number_concurrent>.+?)\s(?<misc_param_1>.+?)\s\w+\s(?<month>.+?)\s+(?<day>.+?)\s(?<host_time>.+?)\s(?<year>.+?)\s(?<message_number>(-)?\d+)\s(?<misc_param_2>(-)?.+?)\s+(?<type>.+?)[\n\r]((?<data_1>.*?)\s?)\s+(?<num_1>(-)?\d+?)[\n\r]\s(?:Server\sName:\s(?<server>.+?)[\n\r])?(?:Task ID: (?<task_id>.+?)\s+Time: (?<task_epoc>.+?)\s+Object: (?<object>.+?)[\n\r])?(?:Exception\s?Class:\s?(?<exception_class>.+?)\s+)?(?:Severity:\s(?<severity>.+?)[\n\r])?(?:Function:\s(?<function>.+?)[\n\r])?(?:PSD:\s(?<psd>.+?)\s+Coil:\s(?<coil>.+?)\s+Scan:\s(?<scan>.+?)[\n\r])?(?<message>.+?)(?:EN\s(?<en>\d+))/s //(?:SR\s(?<sr>.+?)[\n\r])(?<epoch>.+?)\s(?<record_number_concurrent>.+?)\s(?<misc_param_1>.+?)\s\w+\s(?<month>.+?)\s+(?<day>.+?)\s(?<host_time>.+?)\s(?<year>.+?)\s(?<message_number>(-)?\d+)\s(?<misc_param_2>(-)?.+?)\s+(?<type>.+?)[\n\r]((?<data_1>.*?)\s)\s+(?<num_1>.+?)[\n\r]\s(?:Server\sName:\s(?<server>.+?)[\n\r])?(?:Task ID: (?<task_id>.+?)\s+Time: (?<task_epoc>.+?)\s+Object: (?<object>.+?)[\n\r])?(?:Exception\s?Class:\s?(?<exception_class>.+?)\s+)?(?:Severity:\s(?<severity>.+?)[\n\r])?(?:Function:\s(?<function>.+?)[\n\r])?(?:PSD:\s(?<psd>.+?)\s+Coil:\s(?<coil>.+?)\s+Scan:\s(?<scan>.+?)[\n\r])?(?<message>.+?)(?:EN\s(?<en>\d+))
    }
  },
  ct: {
    gesys: {
      block: /SR\s(\d+).*?EN\s\1/gs,
      sub_block:
        /(?:SR\s(?<sr>.+?)[\n\r])(?<epoch>.+?)\s(?<record_number_concurrent>.+?)\s(?<misc_param_1>.+?)\s\w+\s(?<month>.+?)\s+(?<day>.+?)\s(?<host_time>.+?)\s(?<year>.+?)\s(?<message_number>(-)?\d+)\s(?<misc_param_2>(-)?.+?)\s+(?<type>.+?)[\n\r]((?<data_1>.*?)\s?)\s+(?<num_1>(-)?\d+?)[\n\r]\s(?:(?<date_2>.+\d{2}:\d+\s\d{4}?)\s?[\n\r](?:Host\s:\s(?<host>.+?))?\s+(?:Ermes\s\#\s:\s(?<ermes_number>.+?))?[\n\r](?:Exception Class\s:\s(?<exception_class>.+?)\s+)(?:Severity\s:\s(?<severity>.+?))?[\n\r](?:File\s:\s(?<file>.+?)\s+Line\#\s:\s(?<line_number>\d+))?[\n\r])?(?:Function\s?:\s?(.+?)[\n\r])?(?:Scan\sType\s?:\s?(?<scan_type>.+?)[\n\r])?([A-Z]+\s?:\s?(?<warning>.+?)[\n\r])?(?:End:\s(?<end_msg>.+?)[\n\r])?(?<message>.*?)?\s?(?:EN\s(?<en>\d+))/s
      // add - sign to num_1 filed
    }
  },
  cv: {
    sys_error:
      /(?<sequencenumber>.+?),(?<host_date>.+?),(?<host_time>.+?),(?<subsystem>.+?),(?<errorcode>.+?),(?<errortext>.+?),(?<exam>.+?),(?<exceptioncategory>.+?),(?<application>.+?),(?<majorfunction>.+?),(?<minorfunction>.+?),(?<fru>.+?),(?<viewinglevel>.+?),(?<rootcause>.+?),(?<repeatcount>.+?),(?<debugtext>".+"?|.+?),(?<sourcefile>.+?),(?<sourceline>.+)/
  }
};

module.exports = {
  ge_regex
};
