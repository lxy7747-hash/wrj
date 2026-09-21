export const OPENAPI_SCHEMA_SNAPSHOT: Readonly<Record<string, unknown>> = Object.freeze(
{
  "BackupPlan": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "version",
      "enabled",
      "name",
      "intervalMinutes"
    ],
    "properties": {
      "version": {
        "type": "integer",
        "minimum": 1
      },
      "enabled": {
        "type": "boolean"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      },
      "intervalMinutes": {
        "type": "integer",
        "minimum": 60,
        "maximum": 10080
      }
    }
  },
  "BackupExecution": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "startedAt",
      "completedAt",
      "result",
      "backupId",
      "message"
    ],
    "properties": {
      "startedAt": {
        "type": "string",
        "format": "date-time"
      },
      "completedAt": {
        "type": "string",
        "format": "date-time"
      },
      "result": {
        "enum": [
          "SUCCESS",
          "FAILURE"
        ]
      },
      "backupId": {
        "oneOf": [
          {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          {
            "type": "null"
          }
        ]
      },
      "message": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "result": {
              "const": "SUCCESS"
            }
          },
          "required": [
            "result"
          ]
        },
        "then": {
          "properties": {
            "backupId": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            }
          }
        },
        "else": {
          "properties": {
            "backupId": {
              "type": "null"
            }
          }
        }
      }
    ]
  },
  "BackupPlanStatus": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "plan",
      "nextRunAt",
      "executions"
    ],
    "properties": {
      "plan": {
        "$ref": "#/components/schemas/BackupPlan"
      },
      "nextRunAt": {
        "oneOf": [
          {
            "type": "string",
            "format": "date-time"
          },
          {
            "type": "null"
          }
        ]
      },
      "executions": {
        "type": "array",
        "maxItems": 20,
        "items": {
          "$ref": "#/components/schemas/BackupExecution"
        }
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "plan": {
              "properties": {
                "enabled": {
                  "const": true
                }
              },
              "required": [
                "enabled"
              ]
            }
          },
          "required": [
            "plan"
          ]
        },
        "then": {
          "properties": {
            "nextRunAt": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        "else": {
          "properties": {
            "nextRunAt": {
              "type": "null"
            }
          }
        }
      }
    ]
  },
  "PutapiV1AdminBackupPlanRequest": {
    "$ref": "#/components/schemas/BackupPlan"
  },
  "GetapiV1AdminBackupPlanResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/BackupPlanStatus"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    }
  },
  "PutapiV1AdminBackupPlanResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/BackupPlanStatus"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    }
  },
  "LocalArchiveRecord": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "archiveId": {
        "type": "string",
        "pattern": "^ARCH-LOCAL-[a-f0-9]{64}$"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "createdBy": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "sourceKind": {
        "const": "LOCAL_FILE_SNAPSHOT"
      },
      "binding": {
        "const": "UNBOUND"
      },
      "eventFile": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fileName": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        },
        "required": [
          "fileName",
          "sha256"
        ]
      },
      "positionFile": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fileName": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          }
        },
        "required": [
          "fileName",
          "sha256"
        ]
      },
      "reportId": {
        "type": "string",
        "pattern": "^RPT-LOCAL-[a-f0-9]{64}$"
      },
      "nodeCount": {
        "type": "integer",
        "minimum": 1
      },
      "positionCount": {
        "type": "integer",
        "minimum": 0
      },
      "durationS": {
        "type": "number",
        "minimum": 0
      }
    },
    "required": [
      "archiveId",
      "name",
      "createdAt",
      "createdBy",
      "sourceKind",
      "binding",
      "eventFile",
      "positionFile",
      "reportId",
      "nodeCount",
      "positionCount",
      "durationS"
    ]
  },
  "PostapiV1AdminLocalArchivesRequest": {
    "$ref": "#/components/schemas/LocalArchiveRequest"
  },
  "LocalArchiveRequest": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      }
    },
    "required": [
      "name"
    ]
  },
  "LocalArchiveList": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/LocalArchiveRecord"
    }
  },
  "LocalArchiveReplay": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "initial": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "fileName": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S"
          },
          "sha256": {
            "type": "string",
            "pattern": "^[a-f0-9]{64}$"
          },
          "nodes": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "platformId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "time": {
                  "type": "number",
                  "minimum": 0
                },
                "longitude": {
                  "type": "number",
                  "minimum": -180,
                  "maximum": 180
                },
                "latitude": {
                  "type": "number",
                  "minimum": -90,
                  "maximum": 90
                },
                "altitude": {
                  "type": "number"
                },
                "speed": {
                  "type": "number",
                  "minimum": 0
                },
                "heading": {
                  "type": "number"
                },
                "name": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "type": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "side": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "sourceEventId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                }
              },
              "required": [
                "platformId",
                "time",
                "longitude",
                "latitude",
                "altitude",
                "speed",
                "name",
                "type",
                "sourceEventId"
              ]
            },
            "minItems": 1
          },
          "connections": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceEventId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "time": {
                  "type": "number",
                  "minimum": 0
                },
                "scope": {
                  "const": "INTER_PLATFORM"
                },
                "source": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "platformName": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "communicationName": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "address": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    }
                  },
                  "required": [
                    "platformName",
                    "communicationName",
                    "address"
                  ]
                },
                "target": {
                  "type": "object",
                  "additionalProperties": false,
                  "properties": {
                    "platformName": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "communicationName": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    },
                    "address": {
                      "type": "string",
                      "minLength": 1,
                      "pattern": "\\S"
                    }
                  },
                  "required": [
                    "platformName",
                    "communicationName",
                    "address"
                  ]
                },
                "sourceType": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "targetType": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                }
              },
              "required": [
                "sourceEventId",
                "time",
                "scope",
                "source",
                "target",
                "sourceType",
                "targetType"
              ]
            }
          },
          "deviceEvents": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceEventId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "time": {
                  "type": "number",
                  "minimum": 0
                },
                "platformId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "deviceId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "kind": {
                  "enum": [
                    "COMMUNICATION",
                    "JAMMING"
                  ]
                },
                "active": {
                  "type": "boolean"
                },
                "frequencyHz": {
                  "type": "number",
                  "exclusiveMinimum": 0
                },
                "bandwidthHz": {
                  "type": "number",
                  "exclusiveMinimum": 0
                }
              },
              "required": [
                "sourceEventId",
                "time",
                "platformId",
                "deviceId",
                "kind",
                "active"
              ]
            }
          },
          "messageLinks": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "id": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "type": {
                  "enum": [
                    "SAT",
                    "MICROWAVE",
                    "DATALINK",
                    "FIBER"
                  ]
                },
                "sourcePlatformId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "targetPlatformId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "sourceDeviceId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "targetDeviceId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "records": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "sourceEventId": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      "transmitEventId": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      "time": {
                        "type": "number",
                        "minimum": 0
                      },
                      "source": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "platformName": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          },
                          "communicationName": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          }
                        },
                        "required": [
                          "platformName",
                          "communicationName"
                        ]
                      },
                      "target": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                          "platformName": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          },
                          "communicationName": {
                            "type": "string",
                            "minLength": 1,
                            "pattern": "\\S"
                          }
                        },
                        "required": [
                          "platformName",
                          "communicationName"
                        ]
                      },
                      "messageType": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "\\S"
                      },
                      "messageSizeBits": {
                        "type": "number",
                        "minimum": 0
                      },
                      "delayS": {
                        "type": "number",
                        "minimum": 0
                      }
                    },
                    "required": [
                      "sourceEventId",
                      "transmitEventId",
                      "time",
                      "source",
                      "target",
                      "messageType",
                      "messageSizeBits",
                      "delayS"
                    ]
                  }
                },
                "firstTimeS": {
                  "type": "number",
                  "minimum": 0
                },
                "lastTimeS": {
                  "type": "number",
                  "minimum": 0
                },
                "activeIntervals": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                      "startTimeS": {
                        "type": "number",
                        "minimum": 0
                      },
                      "endTimeS": {
                        "type": "number",
                        "minimum": 0
                      }
                    },
                    "required": [
                      "startTimeS",
                      "endTimeS"
                    ]
                  }
                },
                "messageCount": {
                  "type": "integer",
                  "minimum": 0
                },
                "messageTypes": {
                  "type": "array",
                  "items": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "uniqueItems": true
                },
                "direction": {
                  "enum": [
                    "FORWARD",
                    "REVERSE"
                  ]
                },
                "medianDelayS": {
                  "type": "number",
                  "minimum": 0
                }
              },
              "required": [
                "id",
                "type",
                "sourcePlatformId",
                "targetPlatformId",
                "sourceDeviceId",
                "targetDeviceId",
                "records",
                "firstTimeS",
                "lastTimeS",
                "activeIntervals",
                "messageCount",
                "messageTypes",
                "medianDelayS"
              ]
            }
          },
          "platformDeletions": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "sourceEventId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "platformId": {
                  "type": "string",
                  "minLength": 1,
                  "pattern": "\\S"
                },
                "time": {
                  "type": "number",
                  "minimum": 0
                }
              },
              "required": [
                "sourceEventId",
                "platformId",
                "time"
              ]
            }
          }
        },
        "required": [
          "fileName",
          "sha256",
          "nodes"
        ]
      },
      "fileName": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "sha256": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      },
      "durationS": {
        "type": "number",
        "minimum": 0
      },
      "recordCount": {
        "type": "integer",
        "minimum": 0
      },
      "tracks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "platformId": {
              "type": "string",
              "minLength": 1,
              "pattern": "\\S"
            },
            "positions": {
              "type": "array",
              "items": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                  "platformId": {
                    "type": "string",
                    "minLength": 1,
                    "pattern": "\\S"
                  },
                  "time": {
                    "type": "number",
                    "minimum": 0
                  },
                  "longitude": {
                    "type": "number",
                    "minimum": -180,
                    "maximum": 180
                  },
                  "latitude": {
                    "type": "number",
                    "minimum": -90,
                    "maximum": 90
                  },
                  "altitude": {
                    "type": "number"
                  },
                  "speed": {
                    "type": "number",
                    "minimum": 0
                  },
                  "heading": {
                    "type": "number"
                  }
                },
                "required": [
                  "platformId",
                  "time",
                  "longitude",
                  "latitude",
                  "altitude",
                  "speed",
                  "heading"
                ]
              },
              "minItems": 1
            }
          },
          "required": [
            "platformId",
            "positions"
          ]
        }
      },
      "issueCount": {
        "type": "integer",
        "minimum": 0
      },
      "issues": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "line": {
              "type": "integer",
              "minimum": 1
            },
            "message": {
              "type": "string"
            }
          },
          "required": [
            "line",
            "message"
          ]
        }
      },
      "waitingForLine": {
        "type": "boolean"
      }
    },
    "required": [
      "initial",
      "fileName",
      "sha256",
      "durationS",
      "recordCount",
      "tracks",
      "issueCount",
      "issues",
      "waitingForLine"
    ]
  },
  "LocalArchiveSnapshot": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "record": {
        "$ref": "#/components/schemas/LocalArchiveRecord"
      },
      "replay": {
        "$ref": "#/components/schemas/LocalArchiveReplay"
      },
      "report": {
        "$ref": "#/components/schemas/Report"
      }
    },
    "required": [
      "record",
      "replay",
      "report"
    ]
  },
  "GetapiV1AdminLocalArchivesResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/LocalArchiveList"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ]
  },
  "PostapiV1AdminLocalArchivesResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/LocalArchiveRecord"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ]
  },
  "GetapiV1ArchivesArchiveIdResponse": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/LocalArchiveSnapshot"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ]
  },
  "MasterDataEntry": {
    "oneOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "valueType",
          "value"
        ],
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z][A-Za-z0-9_.-]{0,63}$"
          },
          "valueType": {
            "const": "TEXT"
          },
          "value": {
            "type": "string",
            "minLength": 1,
            "pattern": "\\S",
            "maxLength": 1000
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "valueType",
          "value"
        ],
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z][A-Za-z0-9_.-]{0,63}$"
          },
          "valueType": {
            "const": "BOOLEAN"
          },
          "value": {
            "type": "boolean"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "valueType",
          "value"
        ],
        "properties": {
          "key": {
            "type": "string",
            "minLength": 1,
            "pattern": "^[A-Za-z][A-Za-z0-9_.-]{0,63}$"
          },
          "valueType": {
            "const": "NUMBER"
          },
          "value": {
            "type": "number"
          },
          "unit": {
            "type": "string",
            "maxLength": 24
          },
          "minimum": {
            "type": "number"
          },
          "maximum": {
            "type": "number"
          }
        }
      }
    ]
  },
  "MasterDataContent": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "description",
      "entries"
    ],
    "properties": {
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      },
      "description": {
        "type": "string",
        "maxLength": 1000
      },
      "entries": {
        "type": "array",
        "minItems": 1,
        "maxItems": 100,
        "items": {
          "$ref": "#/components/schemas/MasterDataEntry"
        }
      }
    }
  },
  "MasterDataWrite": {
    "allOf": [
      {
        "$ref": "#/components/schemas/MasterData"
      },
      {
        "required": [
          "content"
        ],
        "properties": {
          "kind": {
            "enum": [
              "COMMUNICATION_SYSTEM",
              "PARAMETER_DICTIONARY",
              "ENUMERATION"
            ]
          }
        }
      }
    ],
    "description": "写入必须提供真实内容；运行时额外校验条目键唯一、数值在声明范围内、枚举值唯一且仅文本。旧只读元数据允许缺少 content。"
  },
  "MasterDataReference": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "dataId",
      "dataVersion",
      "targetType",
      "targetId",
      "targetVersion"
    ],
    "properties": {
      "dataId": {
        "type": "string",
        "minLength": 1,
        "not": {
          "enum": [
            ".",
            ".."
          ]
        }
      },
      "dataVersion": {
        "type": "integer",
        "minimum": 1
      },
      "targetType": {
        "enum": [
          "SCENARIO",
          "TEMPLATE"
        ]
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "targetVersion": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      }
    }
  },
  "MasterDataTarget": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "targetType",
      "targetId",
      "targetVersion",
      "name"
    ],
    "properties": {
      "targetType": {
        "enum": [
          "SCENARIO",
          "TEMPLATE"
        ]
      },
      "targetId": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "targetVersion": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S"
      }
    }
  },
  "MasterDataDetails": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "dataId",
      "history",
      "references"
    ],
    "properties": {
      "dataId": {
        "type": "string",
        "minLength": 1,
        "not": {
          "enum": [
            ".",
            ".."
          ]
        }
      },
      "history": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/MasterData"
        }
      },
      "references": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/MasterDataReference"
        },
        "uniqueItems": true
      }
    }
  },
  "MasterDataTargetList": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/MasterDataTarget"
    },
    "uniqueItems": true
  },
  "GetapiV1AdminMasterDataTargetsResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/MasterDataTargetList"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    }
  },
  "GetapiV1AdminMasterDataDataIdDetailsResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/MasterDataDetails"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    }
  },
  "PutapiV1AdminMasterDataDataIdReferenceResponse": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "properties": {
      "ok": {
        "const": true
      },
      "data": {
        "$ref": "#/components/schemas/MasterDataDetails"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      }
    }
  },
  "PutapiV1AdminMasterDataDataIdReferenceRequest": {
    "$ref": "#/components/schemas/MasterDataReference"
  },
  "EquipmentReference": {
    "additionalProperties": false,
    "properties": {
      "equipmentId": {
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      },
      "equipmentVersion": {
        "minimum": 1,
        "type": "integer"
      },
      "linkId": {
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      },
      "scenarioId": {
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      }
    },
    "required": [
      "equipmentId",
      "scenarioId",
      "linkId",
      "equipmentVersion"
    ],
    "type": "object"
  },
  "EquipmentDetails": {
    "additionalProperties": false,
    "properties": {
      "history": {
        "items": {
          "$ref": "#/components/schemas/EquipmentParameter"
        },
        "type": "array"
      },
      "references": {
        "items": {
          "$ref": "#/components/schemas/EquipmentReference"
        },
        "type": "array"
      }
    },
    "required": [
      "history",
      "references"
    ],
    "type": "object"
  },
  "EquipmentReferenceRequest": {
    "additionalProperties": false,
    "properties": {
      "reference": {
        "$ref": "#/components/schemas/EquipmentReference"
      },
      "remove": {
        "type": "boolean"
      }
    },
    "required": [
      "reference",
      "remove"
    ],
    "type": "object"
  },
  "MenuPaths": {
    "items": {
      "enum": [
        "/situation",
        "/scenarios",
        "/reports",
        "/replays",
        "/batches",
        "/blueprint",
        "/interactions",
        "/traceability",
        "/admin/data-exchange",
        "/admin",
        "/admin?section=equipment-library",
        "/admin?section=scenario-templates",
        "/admin?section=audit-logs",
        "/admin?section=master-data",
        "/admin?section=database-backup",
        "/admin?section=simulation-data",
        "/admin?section=runtime-status"
      ],
      "type": "string"
    },
    "minItems": 1,
    "type": "array",
    "uniqueItems": true
  },
  "RoleProfile": {
    "additionalProperties": false,
    "allOf": [
      {
        "else": {
          "properties": {
            "menuPaths": {
              "contains": {
                "const": "/admin"
              }
            },
            "permissions": {
              "contains": {
                "const": "USER_ROLE_MAINTAIN"
              }
            }
          }
        },
        "if": {
          "properties": {
            "baseRole": {
              "const": "OPERATOR"
            }
          },
          "required": [
            "baseRole"
          ]
        },
        "then": {
          "properties": {
            "menuPaths": {
              "items": {
                "enum": [
                  "/situation",
                  "/scenarios",
                  "/reports",
                  "/replays",
                  "/batches",
                  "/blueprint",
                  "/interactions",
                  "/traceability",
                  "/admin/data-exchange"
                ]
              }
            },
            "permissions": {
              "items": {
                "enum": [
                  "BUSINESS_READ",
                  "SCENARIO_DRAFT_WRITE",
                  "SIMULATION_CONTROL",
                  "ORDINARY_REPORT_EXPORT"
                ]
              }
            }
          }
        }
      }
    ],
    "properties": {
      "baseRole": {
        "enum": [
          "ADMIN",
          "OPERATOR"
        ],
        "type": "string"
      },
      "menuPaths": {
        "$ref": "#/components/schemas/MenuPaths"
      },
      "name": {
        "maxLength": 64,
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      },
      "permissions": {
        "contains": {
          "const": "BUSINESS_READ"
        },
        "items": {
          "type": "string"
        },
        "type": "array",
        "uniqueItems": true
      },
      "profileId": {
        "pattern": "^[A-Za-z0-9_-]{1,64}$",
        "type": "string"
      }
    },
    "required": [
      "profileId",
      "name",
      "baseRole",
      "permissions",
      "menuPaths"
    ],
    "type": "object"
  },
  "RoleAssignment": {
    "additionalProperties": false,
    "properties": {
      "profileId": {
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      },
      "userId": {
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      }
    },
    "required": [
      "userId",
      "profileId"
    ],
    "type": "object"
  },
  "AccessControlConfig": {
    "additionalProperties": false,
    "properties": {
      "assignments": {
        "items": {
          "$ref": "#/components/schemas/RoleAssignment"
        },
        "maxItems": 1000,
        "type": "array",
        "uniqueItems": true
      },
      "profiles": {
        "items": {
          "$ref": "#/components/schemas/RoleProfile"
        },
        "maxItems": 100,
        "type": "array",
        "uniqueItems": true
      },
      "version": {
        "minimum": 1,
        "type": "integer"
      }
    },
    "required": [
      "version",
      "profiles",
      "assignments"
    ],
    "type": "object"
  },
  "GetapiV1AdminEquipmentEquipmentIdDetailsResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EquipmentDetails"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "PutapiV1AdminEquipmentEquipmentIdReferenceResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EquipmentDetails"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "GetapiV1AdminAccessControlResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/AccessControlConfig"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "PutapiV1AdminAccessControlResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/AccessControlConfig"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "PutapiV1AdminAccessControlRequest": {
    "$ref": "#/components/schemas/AccessControlConfig"
  },
  "PutapiV1AdminEquipmentEquipmentIdReferenceRequest": {
    "$ref": "#/components/schemas/EquipmentReferenceRequest"
  },
  "LocalReportEvidence": {
    "additionalProperties": false,
    "properties": {
      "connections": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "eventId": {
              "minLength": 1,
              "type": "string"
            },
            "scope": {
              "enum": [
                "INTERNAL",
                "INTER_PLATFORM"
              ]
            },
            "sourceDeviceId": {
              "minLength": 1,
              "type": "string"
            },
            "sourcePlatformId": {
              "minLength": 1,
              "type": "string"
            },
            "targetDeviceId": {
              "minLength": 1,
              "type": "string"
            },
            "targetPlatformId": {
              "minLength": 1,
              "type": "string"
            },
            "time": {
              "minimum": 0,
              "type": "number"
            }
          },
          "required": [
            "eventId",
            "time",
            "scope",
            "sourcePlatformId",
            "sourceDeviceId",
            "targetPlatformId",
            "targetDeviceId"
          ],
          "type": "object"
        },
        "type": "array"
      },
      "deviceEvents": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "deviceId": {
              "minLength": 1,
              "type": "string"
            },
            "eventId": {
              "minLength": 1,
              "type": "string"
            },
            "platformId": {
              "minLength": 1,
              "type": "string"
            },
            "time": {
              "minimum": 0,
              "type": "number"
            },
            "type": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "eventId",
            "type",
            "time",
            "platformId",
            "deviceId"
          ],
          "type": "object"
        },
        "type": "array"
      },
      "endTimeS": {
        "minimum": 0,
        "type": "number"
      },
      "eventCount": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "eventCounts": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "count": {
              "maximum": 9007199254740991,
              "minimum": 1,
              "type": "integer"
            },
            "type": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "type",
            "count"
          ],
          "type": "object"
        },
        "type": "array"
      },
      "eventFile": {
        "additionalProperties": false,
        "properties": {
          "fileName": {
            "minLength": 1,
            "type": "string"
          },
          "sha256": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          }
        },
        "required": [
          "fileName",
          "sha256"
        ],
        "type": "object"
      },
      "eventWarningCount": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "nodes": {
        "items": {
          "additionalProperties": false,
          "properties": {
            "firstTimeS": {
              "minimum": 0,
              "type": "number"
            },
            "lastTimeS": {
              "minimum": 0,
              "type": "number"
            },
            "name": {
              "minLength": 1,
              "type": "string"
            },
            "platformId": {
              "minLength": 1,
              "type": "string"
            },
            "positionCount": {
              "maximum": 9007199254740991,
              "minimum": 0,
              "type": "integer"
            },
            "side": {
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "minLength": 1,
              "type": "string"
            }
          },
          "required": [
            "platformId",
            "name",
            "type",
            "side",
            "positionCount",
            "firstTimeS",
            "lastTimeS"
          ],
          "type": "object"
        },
        "minItems": 1,
        "type": "array"
      },
      "positionCount": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "positionFile": {
        "additionalProperties": false,
        "properties": {
          "fileName": {
            "minLength": 1,
            "type": "string"
          },
          "sha256": {
            "pattern": "^[a-f0-9]{64}$",
            "type": "string"
          }
        },
        "required": [
          "fileName",
          "sha256"
        ],
        "type": "object"
      },
      "positionIssueCount": {
        "maximum": 9007199254740991,
        "minimum": 0,
        "type": "integer"
      },
      "simulationComplete": {
        "type": "boolean"
      },
      "startTimeS": {
        "minimum": 0,
        "type": "number"
      },
      "waitingForPositionLine": {
        "type": "boolean"
      }
    },
    "required": [
      "eventFile",
      "positionFile",
      "startTimeS",
      "endTimeS",
      "simulationComplete",
      "positionCount",
      "positionIssueCount",
      "waitingForPositionLine",
      "eventCount",
      "eventWarningCount",
      "nodes",
      "eventCounts",
      "connections",
      "deviceEvents"
    ],
    "type": "object"
  },
  "LocalReportExportResult": {
    "additionalProperties": false,
    "properties": {
      "filePath": {
        "minLength": 1,
        "type": "string"
      },
      "format": {
        "enum": [
          "HTML",
          "CSV"
        ]
      },
      "generated": {
        "const": true
      },
      "reportId": {
        "pattern": "^RPT-LOCAL-[a-f0-9]{64}$",
        "type": "string"
      },
      "sha256": {
        "pattern": "^[a-f0-9]{64}$",
        "type": "string"
      },
      "status": {
        "const": "SUCCESS"
      },
      "verifiedAt": {
        "format": "date-time",
        "type": "string"
      },
      "watermark": {
        "minLength": 1,
        "type": "string"
      }
    },
    "required": [
      "reportId",
      "generated",
      "status",
      "format",
      "watermark",
      "verifiedAt",
      "filePath",
      "sha256"
    ],
    "type": "object"
  },
  "ReportExportOutcome": {
    "oneOf": [
      {
        "$ref": "#/components/schemas/ReportExportResult"
      },
      {
        "$ref": "#/components/schemas/LocalReportExportResult"
      }
    ]
  },
  "DeleteapiV1AdminEquipmentEquipmentIdResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/DeleteResult"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "EquipmentCreateRequest": {
    "allOf": [
      {
        "$ref": "#/components/schemas/EquipmentParameter"
      },
      {
        "properties": {
          "readOnly": {
            "const": false
          },
          "version": {
            "const": 1
          }
        }
      }
    ]
  },
  "EquipmentUpdateRequest": {
    "allOf": [
      {
        "$ref": "#/components/schemas/EquipmentParameter"
      },
      {
        "properties": {
          "readOnly": {
            "const": false
          }
        }
      }
    ]
  },
  "EquipmentParameter": {
    "additionalProperties": false,
    "description": "管理员维护的装备默认参数；频率单位 MHz，两端同时为空或为有限正数，且下限不得大于上限（由服务端跨字段校验）。未配置使用 null。只读由服务端控制；写入只允许 false。创建版本 1，更新携带当前版本。",
    "properties": {
      "bandwidthMHz": {
        "exclusiveMinimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "berThreshold": {
        "maximum": 1,
        "minimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "dataRateMbps": {
        "exclusiveMinimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "equipmentId": {
        "pattern": "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$",
        "type": "string"
      },
      "frequencyMaxMHz": {
        "exclusiveMinimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "frequencyMinMHz": {
        "exclusiveMinimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "modulation": {
        "maxLength": 32,
        "minLength": 1,
        "pattern": "\\S",
        "type": [
          "string",
          "null"
        ]
      },
      "readOnly": {
        "type": "boolean"
      },
      "txPowerW": {
        "minimum": 0,
        "type": [
          "number",
          "null"
        ]
      },
      "type": {
        "maxLength": 100,
        "minLength": 1,
        "pattern": "\\S",
        "type": "string"
      },
      "version": {
        "minimum": 1,
        "type": "integer"
      }
    },
    "required": [
      "equipmentId",
      "type",
      "frequencyMinMHz",
      "frequencyMaxMHz",
      "modulation",
      "berThreshold",
      "readOnly",
      "version"
    ],
    "type": "object"
  },
  "EquipmentParameterList": {
    "items": {
      "$ref": "#/components/schemas/EquipmentParameter"
    },
    "type": "array"
  },
  "GetapiV1AdminEquipmentResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EquipmentParameterList"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "PostapiV1AdminEquipmentRequest": {
    "$ref": "#/components/schemas/EquipmentCreateRequest"
  },
  "PostapiV1AdminEquipmentResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EquipmentParameter"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  "PutapiV1AdminEquipmentEquipmentIdRequest": {
    "$ref": "#/components/schemas/EquipmentUpdateRequest"
  },
  "PutapiV1AdminEquipmentEquipmentIdResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/EquipmentParameter"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  'AntennaGain': {
    'additionalProperties': false,
    'properties': {
      'rx': {
        'type': 'number'
      },
      'tx': {
        'type': 'number'
      }
    },
    'required': [
      'tx',
      'rx'
    ],
    'type': 'object'
  },
  'ArchiveList': {
    'items': {
      '$ref': '#/components/schemas/ArchiveRecord'
    },
    'type': 'array'
  },
  'ArchiveRecord': {
    'additionalProperties': false,
    'properties': {
      'archiveId': {
        'pattern': '^ARCH-',
        'type': 'string'
      },
      'replayId': {
        'pattern': '^REPLAY-',
        'type': 'string'
      },
      'reportId': {
        'pattern': '^RPT-',
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'status': {
        'const': 'INDEXED'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'archiveId',
      'taskId',
      'scenarioId',
      'runId',
      'replayId',
      'reportId',
      'status'
    ],
    'type': 'object'
  },
  'AuditExportResult': {
    'additionalProperties': false,
    'properties': {
      'classification': {
        'const': 'INTERNAL'
      },
      'content': {
        'minLength': 1,
        'type': 'string'
      },
      'fileName': {
        'pattern': '^operation_audit_[0-9]{14}_[A-Za-z0-9_-]+\\.txt$',
        'type': 'string'
      },
      'generated': {
        'const': true
      },
      'objectId': {
        'const': 'AUDIT-LOG'
      },
      'recordCount': {
        'minimum': 0,
        'type': 'integer'
      },
      'verifiedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'watermark': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'objectId',
      'generated',
      'classification',
      'watermark',
      'verifiedAt',
      'fileName',
      'content',
      'recordCount'
    ],
    'type': 'object'
  },
  'AuditExportRequest': {
    'additionalProperties': false,
    'properties': {
      'action': {
        'minLength': 1,
        'type': 'string'
      },
      'actor': {
        'minLength': 1,
        'type': 'string'
      },
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'export': {
        'const': true
      },
      'from': {
        'format': 'date-time',
        'type': 'string'
      },
      'module': {
        'minLength': 1,
        'type': 'string'
      },
      'result': {
        'enum': [
          'SUCCESS',
          'DENIED',
          'ERROR'
        ],
        'type': 'string'
      },
      'role': {
        'enum': [
          'ADMIN',
          'OPERATOR'
        ],
        'type': 'string'
      },
      'to': {
        'format': 'date-time',
        'type': 'string'
      }
    },
    'required': [
      'export',
      'confirmationId'
    ],
    'type': 'object'
  },
  'AuditList': {
    'items': {
      '$ref': '#/components/schemas/AuditRecord'
    },
    'type': 'array'
  },
  'AuditRecord': {
    'additionalProperties': false,
    'properties': {
      'action': {
        'minLength': 1,
        'type': 'string'
      },
      'actor': {
        'minLength': 1,
        'type': 'string'
      },
      'auditId': {
        'minLength': 1,
        'type': 'string'
      },
      'immutableFixture': {
        'const': true
      },
      'module': {
        'minLength': 1,
        'type': 'string'
      },
      'objectId': {
        'minLength': 1,
        'type': 'string'
      },
      'occurredAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'result': {
        'enum': [
          'SUCCESS',
          'DENIED',
          'ERROR'
        ]
      },
      'role': {
        'enum': [
          'ADMIN',
          'OPERATOR'
        ],
        'type': 'string'
      }
    },
    'required': [
      'auditId',
      'actor',
      'role',
      'module',
      'action',
      'result',
      'occurredAt',
      'immutableFixture'
    ],
    'type': 'object'
  },
  'AuditRequest': {
    'additionalProperties': false,
    'properties': {
      'action': {
        'minLength': 1,
        'type': 'string'
      },
      'actor': {
        'minLength': 1,
        'type': 'string'
      },
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'export': {
        'type': 'boolean'
      },
      'from': {
        'format': 'date-time',
        'type': 'string'
      },
      'module': {
        'minLength': 1,
        'type': 'string'
      },
      'result': {
        'enum': [
          'SUCCESS',
          'DENIED',
          'ERROR'
        ]
      },
      'role': {
        'enum': [
          'ADMIN',
          'OPERATOR'
        ],
        'type': 'string'
      },
      'to': {
        'format': 'date-time',
        'type': 'string'
      }
    },
    'required': [],
    'type': 'object'
  },
  "AuthResult": {
    "additionalProperties": false,
    "properties": {
      "authenticated": {
        "type": "boolean"
      },
      "principal": {
        "additionalProperties": false,
        "properties": {
          "menuPaths": {
            "$ref": "#/components/schemas/MenuPaths"
          },
          "permissions": {
            "items": {
              "type": "string"
            },
            "type": "array"
          },
          "role": {
            "enum": [
              "ADMIN",
              "OPERATOR"
            ],
            "type": "string"
          },
          "userId": {
            "minLength": 1,
            "type": "string"
          },
          "username": {
            "type": "string"
          }
        },
        "required": [
          "userId",
          "username",
          "role",
          "permissions"
        ],
        "type": "object"
      },
      "reason": {
        "enum": [
          "INVALID_CREDENTIALS",
          "ACCOUNT_LOCKED"
        ]
      },
      "sessionCreated": {
        "description": "true for SQLite server sessions; false only for unauthenticated responses or the isolated Mock entry.",
        "type": "boolean"
      }
    },
    "required": [
      "authenticated",
      "sessionCreated"
    ],
    "type": "object"
  },
  'BackupList': {
    'items': {
      '$ref': '#/components/schemas/BackupRecord'
    },
    'type': 'array'
  },
  "BackupRecord": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "backupId",
      "status",
      "checksum",
      "createdAt"
    ],
    "properties": {
      "backupId": {
        "type": "string",
        "minLength": 1
      },
      "status": {
        "enum": [
          "VALID_FIXTURE",
          "INVALID_FIXTURE",
          "VALID",
          "INVALID"
        ]
      },
      "checksum": {
        "type": "string",
        "minLength": 1
      },
      "createdAt": {
        "type": "string",
        "format": "date-time"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      },
      "format": {
        "enum": [
          "SYSTEM_SQLITE_V1",
          "MAIN_SQLITE_V1"
        ]
      }
    },
    "allOf": [
      {
        "if": {
          "properties": {
            "status": {
              "enum": [
                "VALID",
                "INVALID"
              ]
            }
          },
          "required": [
            "status"
          ]
        },
        "then": {
          "properties": {
            "checksum": {
              "pattern": "^[A-F0-9]{64}$"
            }
          }
        }
      }
    ]
  },
  "BackupRequest": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "operation",
      "confirmationId"
    ],
    "properties": {
      "operation": {
        "const": "BACKUP"
      },
      "backupId": {
        "type": "string",
        "minLength": 1
      },
      "confirmationId": {
        "type": "string",
        "minLength": 1
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "pattern": "\\S",
        "maxLength": 80
      }
    }
  },
  'Batch': {
    'additionalProperties': false,
    'properties': {
      'aggregateReportId': {
        'pattern': '^RPT-',
        'type': 'string'
      },
      'batchId': {
        'pattern': '^BATCH-',
        'type': 'string'
      },
      'reportIds': {
        'items': {
          'pattern': '^RPT-',
          'type': 'string'
        },
        'type': 'array'
      },
      'runIds': {
        'items': {
          'pattern': '^RUN-',
          'type': 'string'
        },
        'type': 'array'
      },
      'state': {
        'enum': [
          'DRAFT',
          'VALIDATING',
          'QUEUED',
          'RUNNING',
          'COMPLETED',
          'PARTIAL_FAILURE',
          'CANCELLED',
          'ERROR'
        ]
      }
    },
    'required': [
      'batchId',
      'state',
      'runIds',
      'reportIds',
      'aggregateReportId'
    ],
    'type': 'object',
    'x-fixture-path': '$.batch'
  },
  'BatchCommand': {
    'additionalProperties': false,
    'properties': {
      'command': {
        'enum': [
          'START',
          'CANCEL'
        ]
      }
    },
    'required': [
      'command'
    ],
    'type': 'object'
  },
  'BatchDetail': {
    'additionalProperties': false,
    'properties': {
      'aggregateReport': {
        '$ref': '#/components/schemas/Report'
      },
      'batch': {
        '$ref': '#/components/schemas/Batch'
      },
      'runs': {
        'items': {
          '$ref': '#/components/schemas/BatchRunResult'
        },
        'maxItems': 12,
        'minItems': 12,
        'type': 'array'
      }
    },
    'required': [
      'batch',
      'runs',
      'aggregateReport'
    ],
    'type': 'object'
  },
  'BatchList': {
    'items': {
      '$ref': '#/components/schemas/Batch'
    },
    'type': 'array'
  },
  'BatchReportLink': {
    'additionalProperties': false,
    'properties': {
      'reportId': {
        'pattern': '^RPT-',
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      }
    },
    'required': [
      'reportId',
      'runId'
    ],
    'type': 'object'
  },
  'BatchRequest': {
    'additionalProperties': false,
    'properties': {
      'deterministicOrder': {
        'const': true
      },
      'distancesKm': {
        'const': [
          80,
          100,
          120
        ],
        'items': {
          'minimum': 0,
          'type': 'number'
        },
        'minItems': 1,
        'type': 'array'
      },
      'powersW': {
        'const': [
          50,
          100,
          150,
          200
        ],
        'items': {
          'minimum': 0,
          'type': 'number'
        },
        'minItems': 1,
        'type': 'array'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      }
    },
    'required': [
      'scenarioId',
      'powersW',
      'distancesKm',
      'deterministicOrder'
    ],
    'type': 'object'
  },
  'BatchRunResult': {
    'additionalProperties': false,
    'properties': {
      'avgBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'avgSnrDb': {
        'type': 'number'
      },
      'connectivityDurationS': {
        'minimum': 0,
        'type': 'number'
      },
      'connectivityRate': {
        'maximum': 100,
        'minimum': 0,
        'type': 'number'
      },
      'distanceKm': {
        'minimum': 0,
        'type': 'number'
      },
      'interferenceDurationS': {
        'minimum': 0,
        'type': 'number'
      },
      'maxBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'minSnrDb': {
        'type': 'number'
      },
      'powerW': {
        'minimum': 0,
        'type': 'number'
      },
      'reportId': {
        'pattern': '^RPT-',
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'status': {
        'enum': [
          'COMPLETED',
          'ERROR'
        ]
      },
      'switchCount': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'runId',
      'reportId',
      'powerW',
      'distanceKm',
      'connectivityDurationS',
      'connectivityRate',
      'switchCount',
      'avgBer',
      'maxBer',
      'avgSnrDb',
      'minSnrDb',
      'interferenceDurationS',
      'status'
    ],
    'type': 'object'
  },
  'CapabilityMetadata': {
    'additionalProperties': false,
    'allOf': [
      {
        'else': {
          'properties': {
            'states': {
              'maxItems': 6,
              'minItems': 6
            }
          }
        },
        'if': {
          'properties': {
            'id': {
              'enum': [
                'DSDWRJQTLJS-XQ-FZYXYLLJS-LLJS',
                'DSDWRJQTLJS-XQ-FZYXYLLJS-FHSX',
                'DSDWRJQTLJS-XQ-FZYXYLLJS-SNBER',
                'DSDWRJQTLJS-XQ-FZYXYLLJS-LLZT',
                'DSDWRJQTLJS-XQ-GRYGZ-ESMGL',
                'DSDWRJQTLJS-XQ-LLQHYYX-LLJC',
                'DSDWRJQTLJS-XQ-LLQHYYX-QXL',
                'DSDWRJQTLJS-XQ-LLQHYYX-HXL',
                'DSDWRJQTLJS-XQ-LLQHYYX-QHJY'
              ]
            }
          },
          'required': [
            'id'
          ]
        },
        'then': {
          'properties': {
            'states': {
              'maxItems': 5,
              'minItems': 5,
              'not': {
                'contains': {
                  'const': 'EXECUTING'
                }
              }
            }
          }
        }
      }
    ],
    'properties': {
      'coverage': {
        'enum': [
          'INTERACTIVE_UI',
          'VISIBLE_CONTRACT'
        ]
      },
      'destination': {
        'type': 'string'
      },
      'id': {
        'pattern': '^DSDWRJQTLJS-XQ-',
        'type': 'string'
      },
      'module': {
        'type': 'string'
      },
      'name': {
        'type': 'string'
      },
      'states': {
        'items': {
          'enum': [
            'LOADING',
            'VALIDATING',
            'EXECUTING',
            'SUCCESS',
            'EMPTY',
            'ERROR'
          ]
        },
        'type': 'array',
        'uniqueItems': true
      }
    },
    'required': [
      'id',
      'module',
      'name',
      'coverage',
      'destination',
      'states'
    ],
    'type': 'object'
  },
  'CapabilityMetadataList': {
    'items': {
      '$ref': '#/components/schemas/CapabilityMetadata'
    },
    'maxItems': 29,
    'minItems': 29,
    'type': 'array'
  },
  'Clock': {
    'additionalProperties': {
      'format': 'date-time',
      'type': 'string'
    },
    'type': 'object'
  },
  'ClosedLoopContext': {
    'additionalProperties': false,
    'properties': {
      'affectedLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'detectionEventId': {
        'minLength': 1,
        'type': 'string'
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'frameId',
      'detectionEventId',
      'targetPlatformId',
      'affectedLinkId'
    ],
    'type': 'object'
  },
  'CompositeLossEvidence': {
    'additionalProperties': false,
    'properties': {
      'effectiveNoiseAndInterferenceDbm': {
        'type': 'number'
      },
      'freeSpaceLossDb': {
        'type': 'number'
      },
      'interferenceLossDb': {
        'type': 'number'
      },
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'modelVersion': {
        'const': 'COMPOSITE-LOSS-1.0'
      },
      'noisePowerDbm': {
        'type': 'number'
      },
      'obstructionLossDb': {
        'type': 'number'
      },
      'systemLossDb': {
        'type': 'number'
      },
      'totalPathLossDb': {
        'type': 'number'
      }
    },
    'required': [
      'linkId',
      'freeSpaceLossDb',
      'systemLossDb',
      'obstructionLossDb',
      'interferenceLossDb',
      'totalPathLossDb',
      'noisePowerDbm',
      'effectiveNoiseAndInterferenceDbm',
      'modelVersion'
    ],
    'type': 'object'
  },
  'ConfirmRequest': {
    'additionalProperties': false,
    'properties': {
      'confirm': {
        'const': true
      }
    },
    'required': [
      'confirm'
    ],
    'type': 'object'
  },
  'ConfirmationContext': {
    'additionalProperties': false,
    'properties': {
      'actor': {
        'minLength': 1,
        'type': 'string'
      },
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'createdAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'expiresAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'role': {
        'enum': [
          'ADMIN',
          'OPERATOR'
        ],
        'type': 'string'
      },
      'state': {
        'enum': [
          'CLOSED',
          'AWAITING_CONFIRMATION',
          'CONFIRMED',
          'CANCELLED',
          'EXPIRED',
          'ERROR'
        ]
      }
    },
    'required': [
      'confirmationId',
      'state',
      'actor',
      'role',
      'createdAt',
      'expiresAt'
    ],
    'type': 'object'
  },
  'ConfirmationRequest': {
    'additionalProperties': false,
    'properties': {
      'action': {
        'enum': [
          'SCENARIO_WARNING_CONTINUE',
          'OFFICIAL_TEMPLATE_DELETE',
          'SIMULATION_STOP',
          'BATCH_LEVEL_III_EXPORT',
          'BACKUP_RESTORE',
          'FULL_CONFIG_EXPORT',
          'AUDIT_EXPORT',
          'MASTER_DATA_DELETE'
        ]
      },
      'objectId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'action',
      'objectId'
    ],
    'type': 'object'
  },
  'ContractDescriptor': {
    'additionalProperties': false,
    'properties': {
      'fields': {
        'items': {
          'type': 'string'
        },
        'type': 'array'
      },
      'name': {
        'type': 'string'
      },
      'sourceRef': {
        'type': 'string'
      },
      'version': {
        'type': 'string'
      }
    },
    'required': [
      'name',
      'version',
      'sourceRef',
      'fields'
    ],
    'type': 'object'
  },
  'CopyTemplateRequest': {
    'additionalProperties': false,
    'properties': {
      'name': {
        'minLength': 1,
        'type': 'string'
      },
      'scenarioId': {
        'minLength': 1,
        'pattern': '^SCN-',
        'type': 'string'
      }
    },
    'required': [
      'name'
    ],
    'type': 'object'
  },
  'CsvContractList': {
    'items': {
      '$ref': '#/components/schemas/ContractDescriptor'
    },
    'maxItems': 3,
    'minItems': 3,
    'type': 'array'
  },
  'DecisionMetadata': {
    'additionalProperties': false,
    'properties': {
      'adopted': {
        'type': 'string'
      },
      'conflict': {
        'type': 'string'
      },
      'effect': {
        'type': 'string'
      },
      'id': {
        'pattern': '^DEC-',
        'type': 'string'
      }
    },
    'required': [
      'id',
      'conflict',
      'adopted',
      'effect'
    ],
    'type': 'object'
  },
  'DecisionMetadataList': {
    'items': {
      '$ref': '#/components/schemas/DecisionMetadata'
    },
    'maxItems': 8,
    'minItems': 8,
    'type': 'array'
  },
  'DeleteResult': {
    'additionalProperties': false,
    'properties': {
      'deleted': {
        'type': 'boolean'
      },
      'objectId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'deleted',
      'objectId'
    ],
    'type': 'object'
  },
  'DeleteapiV1AdminMasterDataDataIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/DeleteResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'DeleteapiV1AdminUsersUserIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/DeleteResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'DeleteapiV1ScenariosScenarioIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/DeleteResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'DeleteapiV1TemplatesTemplateIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/DeleteResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'DeterministicFixtures': {
    'additionalProperties': false,
    'properties': {
      'archive': {
        '$ref': '#/components/schemas/ArchiveRecord'
      },
      'audit': {
        'items': {
          '$ref': '#/components/schemas/AuditRecord'
        },
        'type': 'array'
      },
      'backups': {
        'items': {
          '$ref': '#/components/schemas/BackupRecord'
        },
        'type': 'array'
      },
      'batch': {
        '$ref': '#/components/schemas/Batch'
      },
      'batchAggregateReport': {
        '$ref': '#/components/schemas/Report'
      },
      'batchReports': {
        'items': {
          '$ref': '#/components/schemas/BatchReportLink'
        },
        'maxItems': 12,
        'minItems': 12,
        'type': 'array'
      },
      'batchRuns': {
        'items': {
          '$ref': '#/components/schemas/BatchRunResult'
        },
        'maxItems': 12,
        'minItems': 12,
        'type': 'array'
      },
      'clock': {
        '$ref': '#/components/schemas/Clock'
      },
      'contracts': {
        '$ref': '#/components/schemas/FixtureContracts'
      },
      'diagnostics': {
        '$ref': '#/components/schemas/SystemHealth'
      },
      'epoch': {
        'format': 'date-time',
        'type': 'string'
      },
      'events': {
        'items': {
          '$ref': '#/components/schemas/EventRecord'
        },
        'type': 'array'
      },
      'fileArchives': {
        'items': {
          '$ref': '#/components/schemas/FileArchiveFixture'
        },
        'type': 'array'
      },
      'fixtureVersion': {
        'type': 'string'
      },
      'frame': {
        '$ref': '#/components/schemas/TelemetryFrame'
      },
      'masterData': {
        'items': {
          '$ref': '#/components/schemas/MasterData'
        },
        'type': 'array'
      },
      'metadata': {
        '$ref': '#/components/schemas/FixtureMetadata'
      },
      'principals': {
        'items': {
          '$ref': '#/components/schemas/User'
        },
        'type': 'array'
      },
      'replay': {
        '$ref': '#/components/schemas/Replay'
      },
      'report': {
        '$ref': '#/components/schemas/Report'
      },
      'reset': {
        '$ref': '#/components/schemas/ResetFixture'
      },
      'run': {
        '$ref': '#/components/schemas/SimulationRun'
      },
      'scenario': {
        '$ref': '#/components/schemas/ScenarioConfig'
      },
      'scenarioCoverage': {
        '$ref': '#/components/schemas/ScenarioCoverageFixture'
      },
      'schemaVersion': {
        'const': '1.0'
      },
      'script': {
        '$ref': '#/components/schemas/ScriptContract'
      },
      'task': {
        '$ref': '#/components/schemas/TaskFixture'
      },
      'templates': {
        'items': {
          '$ref': '#/components/schemas/ScenarioTemplateIndex'
        },
        'type': 'array'
      },
      'validation': {
        '$ref': '#/components/schemas/FixtureValidationLink'
      }
    },
    'required': [
      'schemaVersion',
      'fixtureVersion',
      'epoch',
      'clock',
      'principals',
      'templates',
      'fileArchives',
      'masterData',
      'backups',
      'audit',
      'diagnostics',
      'scenarioCoverage',
      'scenario',
      'task',
      'script',
      'run',
      'frame',
      'events',
      'replay',
      'report',
      'archive',
      'batch',
      'batchRuns',
      'batchReports',
      'batchAggregateReport',
      'reset',
      'validation',
      'metadata',
      'contracts'
    ],
    'type': 'object',
    'x-fixture-document': 'deterministic-fixtures.json',
    'x-type-contract': 'domain-models.ts#DeterministicFixtureSet'
  },
  'Environment': {
    'additionalProperties': false,
    'properties': {
      'humidityPercent': {
        'maximum': 100,
        'minimum': 0,
        'type': 'number'
      },
      'multipathEnabled': {
        'type': 'boolean'
      },
      'rainCloudAttenuation': {
        'default': 'lightRain',
        'enum': [
          'none',
          'lightRain',
          'moderateRain',
          'heavyRain'
        ],
        'type': 'string'
      },
      'rainLossDbPerKm': {
        'minimum': 0,
        'type': 'number'
      },
      'rainRateMmPerHour': {
        'minimum': 0,
        'type': 'number'
      },
      'seaState': {
        'minimum': 0,
        'type': 'number'
      },
      'simClockSpeed': {
        'default': 2,
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'temperatureC': {
        'type': 'number'
      },
      'transmissionDistance': {
        'default': 300,
        'description': '海峡宽度，单位 km；不是各条链路的实际通信距离。',
        'maximum': 410,
        'minimum': 150,
        'type': 'number'
      }
    },
    'required': [
      'seaState',
      'temperatureC',
      'humidityPercent',
      'rainRateMmPerHour',
      'rainLossDbPerKm',
      'multipathEnabled'
    ],
    'type': 'object'
  },
  'ErrorCode': {
    'enum': [
      'INVALID_REQUEST',
      'VALIDATION_FAILED',
      'NOT_FOUND',
      'CONFLICT',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'PERMISSION_DENIED',
      'LAST_ADMIN_GUARD',
      'CONFIRMATION_REQUIRED',
      'CONFIRMATION_EXPIRED',
      'CONFIG_LOCKED',
      'INVALID_TRANSITION',
      'NODE_LIMIT_EXCEEDED',
      'DUPLICATE_EVENT',
      'VERSION_CONFLICT',
      'FRAME_MISMATCH',
      'HEADER_INVALID',
      'TYPE_INVALID',
      'ENCODING_INVALID',
      'ATOMIC_REPLACE_FAILED',
      'START_FAILED',
      'TIMEOUT',
      'EXIT_NONZERO',
      'CORRUPT_FIXTURE',
      'OUT_OF_RANGE',
      'DEVICE_DISABLED',
      'LOOPBACK_ONLY',
      'TOPIC_FORBIDDEN',
      'SEQUENCE_GAP',
      'INTERNAL_FIXTURE_ERROR'
    ],
    'type': 'string'
  },
  'ErrorDetail': {
    'additionalProperties': false,
    'properties': {
      'code': {
        '$ref': '#/components/schemas/ErrorCode'
      },
      'correlationId': {
        'type': 'string'
      },
      'details': {
        'type': [
          'object',
          'array',
          'string',
          'number',
          'boolean',
          'null'
        ]
      },
      'fieldPath': {
        'type': 'string'
      },
      'message': {
        'type': 'string'
      },
      'retryable': {
        'type': 'boolean'
      }
    },
    'required': [
      'code',
      'message',
      'retryable',
      'correlationId'
    ],
    'type': 'object'
  },
  'ErrorEnvelope': {
    'additionalProperties': false,
    'properties': {
      'error': {
        '$ref': '#/components/schemas/ErrorDetail'
      },
      'meta': {
        'additionalProperties': false,
        'properties': {
          'generatedAt': {
            'format': 'date-time',
            'type': 'string'
          },
          'requestId': {
            'type': 'string'
          }
        },
        'required': [
          'requestId',
          'generatedAt'
        ],
        'type': 'object'
      },
      'ok': {
        'const': false
      }
    },
    'required': [
      'ok',
      'error',
      'meta'
    ],
    'type': 'object'
  },
  'EventList': {
    'items': {
      '$ref': '#/components/schemas/EventRecord'
    },
    'type': 'array'
  },
  'EventRecord': {
    'additionalProperties': false,
    'allOf': [
      {
        'if': {
          'properties': {
            'type': {
              'const': 'DETECTION'
            }
          }
        },
        'then': {
          'required': [
            'sensorId',
            'targetPlatformId',
            'detectionProbability'
          ]
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'LINK_SWITCH'
            }
          }
        },
        'then': {
          'required': [
            'direction',
            'oldLinkId',
            'newLinkId',
            'oldBer',
            'newBer',
            'stabilityFrames',
            'minimumStableFrames',
            'hysteresisSatisfied',
            'cooldownRemainingS',
            'decision',
            'reason'
          ]
        }
      }
    ],
    'properties': {
      'cooldownRemainingS': {
        'minimum': 0,
        'type': 'number'
      },
      'decision': {
        'enum': [
          'ACCEPTED',
          'REJECTED'
        ]
      },
      'dedupeKey': {
        'type': 'string'
      },
      'detectionProbability': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'direction': {
        'enum': [
          'FORWARD',
          'REVERSE'
        ]
      },
      'eventId': {
        'minLength': 1,
        'type': 'string'
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'hysteresisSatisfied': {
        'type': 'boolean'
      },
      'minimumStableFrames': {
        'minimum': 1,
        'type': 'integer'
      },
      'newBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'newLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'oldBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'oldLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'reason': {
        'type': 'string'
      },
      'sensorId': {
        'minLength': 1,
        'type': 'string'
      },
      'sourceRegistryTime': {
        'minimum': 0,
        'type': 'number'
      },
      'stabilityFrames': {
        'minimum': 0,
        'type': 'integer'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      },
      'time': {
        'minimum': 0,
        'type': 'number'
      },
      'type': {
        'enum': [
          'DETECTION',
          'LINK_SWITCH'
        ]
      }
    },
    'required': [
      'eventId',
      'frameId',
      'time',
      'type',
      'dedupeKey'
    ],
    'type': 'object',
    'x-fixture-path': '$.events'
  },
  'ExportStatus': {
    'additionalProperties': false,
    'properties': {
      'classification': {
        'enum': [
          'INTERNAL',
          'LEVEL_II',
          'LEVEL_III'
        ]
      },
      'generated': {
        'const': false
      },
      'objectId': {
        'minLength': 1,
        'type': 'string'
      },
      'verifiedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'watermark': {
        'type': 'string'
      }
    },
    'required': [
      'objectId',
      'generated',
      'classification',
      'watermark',
      'verifiedAt'
    ],
    'type': 'object'
  },
  'FileArchiveFixture': {
    'additionalProperties': false,
    'properties': {
      'contract': {
        'enum': [
          'link_quality.csv',
          'events.csv',
          'link_switch.csv'
        ]
      },
      'createdAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'fileId': {
        'minLength': 1,
        'type': 'string'
      },
      'status': {
        'const': 'VALID_FIXTURE'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'fileId',
      'taskId',
      'contract',
      'status',
      'createdAt'
    ],
    'type': 'object'
  },
  'FixtureContracts': {
    'additionalProperties': false,
    'properties': {
      'csv': {
        '$ref': '#/components/schemas/CsvContractList'
      },
      'frontendTypes': {
        '$ref': '#/components/schemas/FrontendContractList'
      },
      'scenarioConfig': {
        '$ref': '#/components/schemas/ContractDescriptor'
      }
    },
    'required': [
      'scenarioConfig',
      'frontendTypes',
      'csv'
    ],
    'type': 'object'
  },
  'FixtureMetadata': {
    'additionalProperties': false,
    'properties': {
      'capabilities': {
        '$ref': '#/components/schemas/CapabilityMetadataList'
      },
      'decisions': {
        '$ref': '#/components/schemas/DecisionMetadataList'
      },
      'interfaces': {
        '$ref': '#/components/schemas/InterfaceMetadataList'
      },
      'routes': {
        '$ref': '#/components/schemas/RouteMetadataList'
      }
    },
    'required': [
      'capabilities',
      'interfaces',
      'decisions',
      'routes'
    ],
    'type': 'object'
  },
  'FixtureValidationLink': {
    'additionalProperties': false,
    'properties': {
      'fixturePaths': {
        'additionalProperties': {
          'type': 'string'
        },
        'type': 'object'
      },
      'openApiDocument': {
        'const': 'mock-api.openapi.yaml'
      },
      'requiredEvidence': {
        'items': {
          'type': 'string'
        },
        'type': 'array'
      },
      'rootSchema': {
        'const': '#/components/schemas/DeterministicFixtures'
      },
      'typeContract': {
        'const': 'domain-models.ts#DeterministicFixtureSet'
      }
    },
    'required': [
      'openApiDocument',
      'rootSchema',
      'typeContract',
      'fixturePaths',
      'requiredEvidence'
    ],
    'type': 'object'
  },
  'FrameEvidence': {
    'additionalProperties': false,
    'properties': {
      'jammerExecution': {
        '$ref': '#/components/schemas/JammerExecutionEvidence'
      },
      'losses': {
        'items': {
          '$ref': '#/components/schemas/CompositeLossEvidence'
        },
        'type': 'array'
      },
      'routeCandidates': {
        'items': {
          '$ref': '#/components/schemas/RouteCandidateEvidence'
        },
        'type': 'array'
      },
      'routeDecisions': {
        'items': {
          '$ref': '#/components/schemas/RouteDecision'
        },
        'maxItems': 2,
        'minItems': 0,
        'type': 'array'
      },
      'synchronization': {
        '$ref': '#/components/schemas/SynchronizationEvidence'
      }
    },
    'required': [
      'losses',
      'routeCandidates',
      'routeDecisions',
      'synchronization',
      'jammerExecution'
    ],
    'type': 'object'
  },
  'FrequencyRange': {
    'additionalProperties': false,
    'properties': {
      'max': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'min': {
        'exclusiveMinimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'min',
      'max'
    ],
    'type': 'object'
  },
  'FrontendContractList': {
    'items': {
      '$ref': '#/components/schemas/ContractDescriptor'
    },
    'maxItems': 5,
    'minItems': 5,
    'type': 'array'
  },
  'FullConfigExportRequest': {
    'additionalProperties': false,
    'properties': {
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'format': {
        'const': 'JSON'
      }
    },
    'required': [
      'format',
      'confirmationId'
    ],
    'type': 'object'
  },
  'GetapiV1AdminArchivesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ArchiveList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AdminAuditResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/AuditList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AdminBackupsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/BackupList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AdminHealthResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SystemHealth'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AdminMasterDataResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/MasterDataList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AdminUsersResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/UserList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AuthPermissionsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/PermissionSet'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1AuthSessionResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/AuthResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1BatchesBatchIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/BatchDetail'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1BatchesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/BatchList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ContractsCsvResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/CsvContractList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ContractsFrontendTypesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/FrontendContractList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ContractsScenarioConfigResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ContractDescriptor'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1MetaCapabilitiesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/CapabilityMetadataList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1MetaDecisionsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/DecisionMetadataList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1MetaInterfacesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/InterfaceMetadataList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1MetaRoutesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/RouteMetadataList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ReplaysReplayIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/Replay'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ReplaysResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ReplayList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ReportsReportIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/Report'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ReportsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ReportList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ScenariosResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1ScenariosScenarioIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1SimulationsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SimulationRunList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1SimulationsRunIdEventsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/EventList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1SimulationsRunIdFramesFrameIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/TelemetryFrame'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1SimulationsRunIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SimulationRun'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1TemplatesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/TemplateList'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'GetapiV1TemplatesTemplateIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioTemplate'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'ImportResult': {
    'additionalProperties': false,
    'properties': {
      'drafts': {
        'items': {
          '$ref': '#/components/schemas/ScenarioDraft'
        },
        'type': 'array'
      },
      'imported': {
        'minimum': 0,
        'type': 'integer'
      },
      'rejected': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'imported',
      'rejected',
      'drafts'
    ],
    'type': 'object'
  },
  'InformationDemand': {
    'additionalProperties': false,
    'if': {
      'required': [
        'linkId'
      ]
    },
    'properties': {
      'destinationPlatformIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'minItems': 1,
        'type': 'array',
        'uniqueItems': true
      },
      'direction': {
        'enum': [
          'FORWARD',
          'REVERSE'
        ]
      },
      'enabled': {
        'type': 'boolean'
      },
      'frequencyHz': {
        'minimum': 0,
        'type': 'number'
      },
      'id': {
        'minLength': 1,
        'type': 'string'
      },
      'informationType': {
        'type': 'string'
      },
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'maxLatencyMs': {
        'minimum': 0,
        'type': 'number'
      },
      'minDataRateMbps': {
        'minimum': 0,
        'type': 'number'
      },
      'priority': {
        'enum': [
          'HIGH',
          'NORMAL'
        ]
      },
      'sourcePlatformId': {
        'minLength': 1,
        'type': 'string'
      },
      'volumeMb': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'id',
      'sourcePlatformId',
      'destinationPlatformIds',
      'informationType',
      'volumeMb',
      'frequencyHz',
      'priority',
      'maxLatencyMs',
      'minDataRateMbps'
    ],
    'then': {
      'properties': {
        'destinationPlatformIds': {
          'maxItems': 1
        }
      },
      'required': [
        'direction'
      ]
    },
    'type': 'object'
  },
  'InterfaceMetadata': {
    'additionalProperties': false,
    'properties': {
      'destination': {
        'type': 'string'
      },
      'id': {
        'pattern': '^DSDWRJQTLJS-JK-',
        'type': 'string'
      },
      'kind': {
        'enum': [
          '外部',
          '内部'
        ]
      },
      'name': {
        'type': 'string'
      }
    },
    'required': [
      'id',
      'kind',
      'name',
      'destination'
    ],
    'type': 'object'
  },
  'InterfaceMetadataList': {
    'items': {
      '$ref': '#/components/schemas/InterfaceMetadata'
    },
    'maxItems': 7,
    'minItems': 7,
    'type': 'array'
  },
  'Jammer': {
    'additionalProperties': false,
    'properties': {
      'autoDetect': {
        'type': 'boolean'
      },
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'defaultPower': {
        'minimum': 0,
        'type': 'number'
      },
      'detectionRange': {
        'minimum': 0,
        'type': 'number'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'id': {
        'minLength': 1,
        'type': 'string'
      },
      'platformId': {
        'minLength': 1,
        'type': 'string'
      },
      'triggerTimeS': {
        'minimum': 0,
        'type': 'number'
      },
      'type': {
        'enum': [
          'BARRAGE',
          'SPOT',
          'SWEEP'
        ],
        'type': 'string'
      }
    },
    'required': [
      'id',
      'platformId',
      'type',
      'defaultPower',
      'frequency',
      'bandwidth',
      'autoDetect',
      'detectionRange'
    ],
    'type': 'object'
  },
  'JammerExecutionEvidence': {
    'additionalProperties': false,
    'properties': {
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'duration': {
        'minimum': 0,
        'type': 'number'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      },
      'power': {
        'minimum': 0,
        'type': 'number'
      },
      'reason': {
        'minLength': 1,
        'type': 'string'
      },
      'startTime': {
        'minimum': 0,
        'type': 'number'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'jammerId',
      'targetPlatformId',
      'power',
      'frequency',
      'bandwidth',
      'startTime',
      'duration',
      'reason'
    ],
    'type': 'object'
  },
  'JammerState': {
    'additionalProperties': false,
    'properties': {
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'direction': {
        'maximum': 360,
        'minimum': 0,
        'type': 'number'
      },
      'duration': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'effectiveFrameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'enabled': {
        'type': 'boolean'
      },
      'executionStatus': {
        'const': 'SUCCESS'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      },
      'power': {
        'minimum': 0,
        'type': 'number'
      },
      'reason': {
        'minLength': 1,
        'type': 'string'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'taskId',
      'jammerId',
      'enabled',
      'frequency',
      'bandwidth',
      'power',
      'direction',
      'duration',
      'executionStatus',
      'effectiveFrameId',
      'reason'
    ],
    'type': 'object'
  },
  'JammerStatusData': {
    'additionalProperties': false,
    'properties': {
      'active': {
        'type': 'boolean'
      },
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      },
      'platformId': {
        'minLength': 1,
        'type': 'string'
      },
      'power': {
        'minimum': 0,
        'type': 'number'
      },
      'targetPlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'time': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'time',
      'jammerId',
      'platformId',
      'power',
      'frequency',
      'bandwidth',
      'active'
    ],
    'type': 'object'
  },
  'JammerUiExtension': {
    'additionalProperties': false,
    'properties': {
      'direction': {
        'maximum': 360,
        'minimum': 0,
        'type': 'number'
      },
      'duration': {
        'minimum': 0,
        'type': 'number'
      },
      'enabled': {
        'type': 'boolean'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'jammerId',
      'direction',
      'duration',
      'enabled'
    ],
    'type': 'object'
  },
  'JammingCommand': {
    'additionalProperties': false,
    'properties': {
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'direction': {
        'maximum': 360,
        'minimum': 0,
        'type': 'number'
      },
      'duration': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'enabled': {
        'type': 'boolean'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'power': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'enabled',
      'frequency',
      'bandwidth',
      'power',
      'direction',
      'duration'
    ],
    'type': 'object'
  },
  'JammingDecision': {
    'additionalProperties': false,
    'properties': {
      'action': {
        'const': 'START'
      },
      'affectedLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'decisionId': {
        'minLength': 1,
        'type': 'string'
      },
      'detectionEventId': {
        'minLength': 1,
        'type': 'string'
      },
      'effectiveFrameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      },
      'linkStatus': {
        'enum': [
          'UP',
          'DEGRADED',
          'DOWN'
        ]
      },
      'reason': {
        'minLength': 1,
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'decisionId',
      'runId',
      'frameId',
      'detectionEventId',
      'targetPlatformId',
      'jammerId',
      'affectedLinkId',
      'action',
      'linkStatus',
      'effectiveFrameId',
      'reason'
    ],
    'type': 'object'
  },
  'JammingParameterSet': {
    'additionalProperties': false,
    'properties': {
      'effectiveFrameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'parameters': {
        '$ref': '#/components/schemas/JammingCommand'
      },
      'version': {
        'minimum': 1,
        'type': 'integer'
      }
    },
    'required': [
      'version',
      'effectiveFrameId',
      'parameters'
    ],
    'type': 'object'
  },
  'Link': {
    'additionalProperties': false,
    'allOf': [
      {
        'else': {
          'properties': {
            'relayPlatformId': {
              'type': 'null'
            }
          }
        },
        'if': {
          'properties': {
            'type': {
              'const': 'SAT'
            }
          }
        }
      }
    ],
    'properties': {
      'antennaGain': {
        '$ref': '#/components/schemas/AntennaGain'
      },
      'antennaGainCorrectionDb': {
        'default': 0,
        'type': 'number'
      },
      'antiJammingGainDb': {
        'default': 0,
        'minimum': 0,
        'type': 'number'
      },
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'berThreshold': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'coding': {
        'pattern': '^[A-Za-z0-9][A-Za-z0-9_.()+/=-]{0,63}$',
        'type': [
          'string',
          'null'
        ]
      },
      'dataRate': {
        'minimum': 0,
        'type': 'number'
      },
      'direction': {
        'enum': [
          'FORWARD',
          'REVERSE'
        ],
        'type': 'string'
      },
      'enabled': {
        'default': true,
        'type': 'boolean'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'id': {
        'minLength': 1,
        'type': 'string'
      },
      'modulation': {
        'enum': [
          'BPSK',
          'QPSK'
        ],
        'type': 'string'
      },
      'relayPlatformId': {
        'minLength': 1,
        'type': [
          'string',
          'null'
        ]
      },
      'sourcePlatformId': {
        'minLength': 1,
        'type': 'string'
      },
      'spatialIsolationDb': {
        'default': 0,
        'minimum': 0,
        'type': 'number'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      },
      'txPower': {
        'minimum': 0,
        'type': 'number'
      },
      'type': {
        'enum': [
          'SAT',
          'MICROWAVE',
          'DATALINK',
          'LASER'
        ],
        'type': 'string'
      }
    },
    'required': [
      'id',
      'type',
      'sourcePlatformId',
      'targetPlatformId',
      'frequency',
      'bandwidth',
      'txPower',
      'antennaGain',
      'modulation',
      'berThreshold',
      'dataRate',
      'direction'
    ],
    'type': 'object'
  },
  'LinkQualityData': {
    'additionalProperties': false,
    'properties': {
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'ber': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'berThreshold': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'dataRate': {
        'minimum': 0,
        'type': 'number'
      },
      'destPlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'distance': {
        'minimum': 0,
        'type': 'number'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'jammingPower': {
        'type': 'number'
      },
      'linkStatus': {
        'enum': [
          'UP',
          'DOWN'
        ]
      },
      'linkType': {
        'enum': [
          'SAT',
          'MICROWAVE',
          'DATALINK',
          'LASER'
        ],
        'type': 'string'
      },
      'modulation': {
        'enum': [
          'BPSK',
          'QPSK'
        ],
        'type': 'string'
      },
      'pathLoss': {
        'type': 'number'
      },
      'receivedPower': {
        'type': 'number'
      },
      'rxAntennaGain': {
        'type': 'number'
      },
      'snr': {
        'type': 'number'
      },
      'sourcePlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'time': {
        'minimum': 0,
        'type': 'number'
      },
      'txAntennaGain': {
        'type': 'number'
      },
      'txPower': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'time',
      'sourcePlatform',
      'destPlatform',
      'linkType',
      'frequency',
      'bandwidth',
      'distance',
      'txPower',
      'txAntennaGain',
      'rxAntennaGain',
      'pathLoss',
      'jammingPower',
      'receivedPower',
      'snr',
      'modulation',
      'ber',
      'linkStatus',
      'berThreshold',
      'dataRate'
    ],
    'type': 'object',
    'x-source': 'SRS §3.5.4'
  },
  'LinkStatusSummary': {
    'additionalProperties': false,
    'properties': {
      'currentBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'currentSnr': {
        'type': 'number'
      },
      'destPlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'linkKey': {
        'minLength': 1,
        'type': 'string'
      },
      'linkType': {
        'enum': [
          'SAT',
          'MICROWAVE',
          'DATALINK',
          'LASER'
        ],
        'type': 'string'
      },
      'sourcePlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'status': {
        'enum': [
          'UP',
          'DOWN'
        ],
        'type': 'string'
      },
      'updatedAt': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'linkKey',
      'sourcePlatform',
      'destPlatform',
      'linkType',
      'currentSnr',
      'currentBer',
      'status',
      'updatedAt'
    ],
    'type': 'object',
    'x-source': 'SRS §3.5.4'
  },
  'LoginRequest': {
    'additionalProperties': false,
    'properties': {
      'passwordFixture': {
        'description': 'Legacy wire field name retained for compatibility; carries the entered password, never a fixture selector. Do not log or persist plaintext.',
        'maxLength': 128,
        'minLength': 1,
        'type': 'string',
        'writeOnly': true
      },
      'username': {
        'maxLength': 64,
        'minLength': 1,
        'pattern': '.*\\S.*',
        'type': 'string'
      }
    },
    'required': [
      'username',
      'passwordFixture'
    ],
    'type': 'object'
  },
  'LogoutRequest': {
    'additionalProperties': false,
    'properties': {
      'confirm': {
        'const': true
      }
    },
    'required': [
      'confirm'
    ],
    'type': 'object'
  },
  'MasterData': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'dataId',
      'kind',
      'version',
      'referenceCount',
      'active'
    ],
    'properties': {
      'dataId': {
        'type': 'string',
        'minLength': 1,
        'not': {
          'enum': [
            '.',
            '..'
          ]
        }
      },
      'kind': {
        'type': 'string',
        'minLength': 1,
        'pattern': '\\S'
      },
      'version': {
        'type': 'integer',
        'minimum': 1
      },
      'referenceCount': {
        'type': 'integer',
        'minimum': 0
      },
      'active': {
        'type': 'boolean'
      },
      'content': {
        '$ref': '#/components/schemas/MasterDataContent'
      }
    }
  },
  'MasterDataList': {
    'items': {
      '$ref': '#/components/schemas/MasterData'
    },
    'type': 'array'
  },
  'MasterDataRequest': {
    'type': 'object',
    'additionalProperties': false,
    'required': [
      'operation',
      'data'
    ],
    'properties': {
      'operation': {
        'enum': [
          'CREATE',
          'UPDATE',
          'DELETE'
        ]
      },
      'data': {
        '$ref': '#/components/schemas/MasterDataWrite'
      },
      'confirmationId': {
        'type': 'string',
        'minLength': 1
      }
    }
  },
  'Meta': {
    'additionalProperties': false,
    'properties': {
      'generatedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'page': {
        'minimum': 1,
        'type': 'integer'
      },
      'pageSize': {
        'minimum': 1,
        'type': 'integer'
      },
      'requestId': {
        'type': 'string'
      },
      'total': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'requestId',
      'generatedAt',
      'page',
      'pageSize',
      'total'
    ],
    'type': 'object'
  },
  'MutationRequest': {
    'additionalProperties': false,
    'properties': {
      'expectedRevision': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'expectedRevision'
    ],
    'type': 'object'
  },
  'OutputConfig': {
    'additionalProperties': false,
    'properties': {
      'directory': {
        'minLength': 1,
        'type': 'string'
      },
      'eventsEnabled': {
        'type': 'boolean'
      },
      'linkQualityEnabled': {
        'type': 'boolean'
      },
      'linkSwitchEnabled': {
        'type': 'boolean'
      },
      'writeInterval': {
        'exclusiveMinimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'directory',
      'writeInterval',
      'linkQualityEnabled',
      'eventsEnabled',
      'linkSwitchEnabled'
    ],
    'type': 'object'
  },
  "PermissionSet": {
    "additionalProperties": false,
    "properties": {
      "menuPaths": {
        "$ref": "#/components/schemas/MenuPaths"
      },
      "permissions": {
        "items": {
          "type": "string"
        },
        "type": "array",
        "uniqueItems": true
      },
      "role": {
        "enum": [
          "ADMIN",
          "OPERATOR"
        ],
        "type": "string"
      }
    },
    "required": [
      "role",
      "permissions"
    ],
    "type": "object"
  },
  'Platform': {
    'additionalProperties': false,
    'allOf': [
      {
        'if': {
          'properties': {
            'type': {
              'const': 'REAR_COMMAND_NODE'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'ground'
            }
          }
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'FORWARD_RELAY_NODE'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'air'
            }
          }
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'GROUND_CLUSTER_COMMAND_NODE'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'ground'
            }
          }
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'AIRBORNE_MISSION_CLUSTER'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'air'
            }
          }
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'COMMUNICATION_SATELLITE'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'space'
            }
          }
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'GROUND_JAMMER_DETECTION_STATION'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'ground'
            }
          }
        }
      },
      {
        'else': {
          'not': {
            'required': [
              'satelliteType'
            ]
          }
        },
        'if': {
          'properties': {
            'type': {
              'const': 'COMMUNICATION_SATELLITE'
            }
          },
          'required': [
            'type'
          ]
        }
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'AIRBORNE_JAMMER_PLATFORM'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'properties': {
            'category': {
              'const': 'air'
            }
          }
        }
      }
    ],
    'properties': {
      'category': {
        'enum': [
          'ground',
          'air',
          'space'
        ],
        'type': 'string'
      },
      'id': {
        'minLength': 1,
        'type': 'string'
      },
      'initialPosition': {
        '$ref': '#/components/schemas/Position'
      },
      'jammerIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array',
        'uniqueItems': true
      },
      'linkIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array',
        'uniqueItems': true
      },
      'name': {
        'minLength': 1,
        'type': 'string'
      },
      'satelliteType': {
        'description': '仅通信卫星使用；旧场景允许缺省。',
        'enum': [
          'TIANTONG',
          'SHENTONG'
        ],
        'type': 'string'
      },
      'sensorIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array',
        'uniqueItems': true
      },
      'type': {
        'enum': [
          'REAR_COMMAND_NODE',
          'FORWARD_RELAY_NODE',
          'GROUND_CLUSTER_COMMAND_NODE',
          'AIRBORNE_MISSION_CLUSTER',
          'COMMUNICATION_SATELLITE',
          'GROUND_JAMMER_DETECTION_STATION',
          'AIRBORNE_JAMMER_PLATFORM'
        ],
        'type': 'string'
      },
      'waypoints': {
        'items': {
          '$ref': '#/components/schemas/Waypoint'
        },
        'type': 'array'
      }
    },
    'required': [
      'id',
      'name',
      'type',
      'category',
      'initialPosition',
      'waypoints',
      'linkIds',
      'sensorIds',
      'jammerIds'
    ],
    'type': 'object'
  },
  'PlatformStatus': {
    'additionalProperties': false,
    'properties': {
      'altitude': {
        'minimum': 0,
        'type': 'number'
      },
      'jammers': {
        'items': {
          '$ref': '#/components/schemas/JammerStatusData'
        },
        'type': 'array'
      },
      'latitude': {
        'maximum': 90,
        'minimum': -90,
        'type': 'number'
      },
      'linkIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array',
        'uniqueItems': true
      },
      'longitude': {
        'maximum': 180,
        'minimum': -180,
        'type': 'number'
      },
      'name': {
        'type': 'string'
      },
      'platformId': {
        'minLength': 1,
        'type': 'string'
      },
      'speed': {
        'minimum': 0,
        'type': 'number'
      },
      'type': {
        'enum': [
          'REAR_COMMAND_NODE',
          'FORWARD_RELAY_NODE',
          'GROUND_CLUSTER_COMMAND_NODE',
          'AIRBORNE_MISSION_CLUSTER',
          'COMMUNICATION_SATELLITE',
          'GROUND_JAMMER_DETECTION_STATION',
          'AIRBORNE_JAMMER_PLATFORM'
        ],
        'type': 'string'
      },
      'updatedAt': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'platformId',
      'name',
      'type',
      'longitude',
      'latitude',
      'altitude',
      'speed',
      'linkIds',
      'jammers',
      'updatedAt'
    ],
    'type': 'object'
  },
  'PlatformWrite': {
    'allOf': [
      {
        '$ref': '#/components/schemas/Platform'
      },
      {
        'if': {
          'properties': {
            'type': {
              'const': 'COMMUNICATION_SATELLITE'
            }
          },
          'required': [
            'type'
          ]
        },
        'then': {
          'required': [
            'satelliteType'
          ]
        }
      }
    ]
  },
  'Position': {
    'additionalProperties': false,
    'properties': {
      'altitude': {
        'minimum': 0,
        'type': 'number'
      },
      'latitude': {
        'maximum': 90,
        'minimum': -90,
        'type': 'number'
      },
      'longitude': {
        'maximum': 180,
        'minimum': -180,
        'type': 'number'
      }
    },
    'required': [
      'longitude',
      'latitude',
      'altitude'
    ],
    'type': 'object'
  },
  'PostapiV1AdminAuditExportRequest': {
    '$ref': '#/components/schemas/AuditExportRequest'
  },
  'PostapiV1AdminAuditExportResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/AuditExportResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AdminBackupRequest': {
    '$ref': '#/components/schemas/BackupRequest'
  },
  'PostapiV1AdminBackupResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/BackupRecord'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AdminConfigExportRequest': {
    '$ref': '#/components/schemas/FullConfigExportRequest'
  },
  'PostapiV1AdminConfigExportResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ExportStatus'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AdminMasterDataRequest': {
    '$ref': '#/components/schemas/MasterDataRequest'
  },
  'PostapiV1AdminMasterDataResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/MasterData'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AdminRestoreRequest': {
    '$ref': '#/components/schemas/RestoreRequest'
  },
  'PostapiV1AdminRestoreResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/RestoreResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AdminUsersRequest': {
    '$ref': '#/components/schemas/UserRoleCommand'
  },
  'PostapiV1AdminUsersResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/User'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AuthLoginRequest': {
    '$ref': '#/components/schemas/LoginRequest'
  },
  'PostapiV1AuthLoginResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/AuthResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1AuthLogoutRequest': {
    '$ref': '#/components/schemas/LogoutRequest'
  },
  'PostapiV1AuthLogoutResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/AuthResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1BatchesBatchIdCommandsRequest': {
    '$ref': '#/components/schemas/BatchCommand'
  },
  'PostapiV1BatchesBatchIdCommandsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/Batch'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1BatchesRequest': {
    '$ref': '#/components/schemas/BatchRequest'
  },
  'PostapiV1BatchesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/Batch'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ConfirmationsConfirmationIdRequest': {
    '$ref': '#/components/schemas/ConfirmRequest'
  },
  'PostapiV1ConfirmationsConfirmationIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ConfirmationContext'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ConfirmationsRequest': {
    '$ref': '#/components/schemas/ConfirmationRequest'
  },
  'PostapiV1ConfirmationsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ConfirmationContext'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ReplaysReplayIdCommandsRequest': {
    '$ref': '#/components/schemas/ReplayCommand'
  },
  'PostapiV1ReplaysReplayIdCommandsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/Replay'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ReportsReportIdExportRequest': {
    '$ref': '#/components/schemas/ReportExportRequest'
  },
  "PostapiV1ReportsReportIdExportResponse": {
    "additionalProperties": false,
    "properties": {
      "data": {
        "$ref": "#/components/schemas/ReportExportOutcome"
      },
      "meta": {
        "$ref": "#/components/schemas/Meta"
      },
      "ok": {
        "const": true
      }
    },
    "required": [
      "ok",
      "data",
      "meta"
    ],
    "type": "object"
  },
  'PostapiV1ResetRequest': {
    '$ref': '#/components/schemas/ResetRequest'
  },
  'PostapiV1ResetResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ResetResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScenariosImportRequest': {
    '$ref': '#/components/schemas/ScenarioImportRequest'
  },
  'PostapiV1ScenariosImportResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ImportResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScenariosRequest': {
    '$ref': '#/components/schemas/ScenarioDraftUpdate'
  },
  'PostapiV1ScenariosResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScenariosScenarioIdResetRequest': {
    '$ref': '#/components/schemas/MutationRequest'
  },
  'PostapiV1ScenariosScenarioIdResetResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScenariosScenarioIdUndoRequest': {
    '$ref': '#/components/schemas/MutationRequest'
  },
  'PostapiV1ScenariosScenarioIdUndoResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScenariosScenarioIdValidateRequest': {
    '$ref': '#/components/schemas/ScenarioValidationRequest'
  },
  'PostapiV1ScenariosScenarioIdValidateResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ValidationResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScriptsPreviewRequest': {
    '$ref': '#/components/schemas/ScriptPreviewRequest'
  },
  'PostapiV1ScriptsPreviewResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScriptContract'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1ScriptsScriptIdPreflightRequest': {
    '$ref': '#/components/schemas/PreflightRequest'
  },
  'PostapiV1ScriptsScriptIdPreflightResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ValidationResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1SimulationsRequest': {
    '$ref': '#/components/schemas/SimulationCreateRequest'
  },
  'PostapiV1SimulationsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SimulationRun'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1SimulationsRunIdCommandsRequest': {
    '$ref': '#/components/schemas/SimulationCommand'
  },
  'PostapiV1SimulationsRunIdCommandsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SimulationRun'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1SimulationsRunIdEventsRequest': {
    '$ref': '#/components/schemas/ClosedLoopContext'
  },
  'PostapiV1SimulationsRunIdEventsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/JammingDecision'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1TasksTaskIdJammersJammerIdCommandsRequest': {
    '$ref': '#/components/schemas/JammingCommand'
  },
  'PostapiV1TasksTaskIdJammersJammerIdCommandsResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/JammerState'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1TasksTaskIdJammersJammerIdParametersRequest': {
    '$ref': '#/components/schemas/JammingParameterSet'
  },
  'PostapiV1TasksTaskIdJammersJammerIdParametersResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/SyncResult'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1TemplatesRequest': {
    '$ref': '#/components/schemas/TemplateMutationRequest'
  },
  'PostapiV1TemplatesResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioTemplate'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PostapiV1TemplatesTemplateIdCopyRequest': {
    '$ref': '#/components/schemas/CopyTemplateRequest'
  },
  'PostapiV1TemplatesTemplateIdCopyResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PreflightRequest': {
    'additionalProperties': false,
    'properties': {
      'checksum': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'checksum'
    ],
    'type': 'object'
  },
  'PutapiV1AdminMasterDataDataIdRequest': {
    '$ref': '#/components/schemas/MasterDataRequest'
  },
  'PutapiV1AdminMasterDataDataIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/MasterData'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PutapiV1AdminUsersUserIdRequest': {
    '$ref': '#/components/schemas/UserRoleCommand'
  },
  'PutapiV1AdminUsersUserIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/User'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PutapiV1ScenariosScenarioIdRequest': {
    '$ref': '#/components/schemas/ScenarioDraftUpdate'
  },
  'PutapiV1ScenariosScenarioIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioDraft'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'PutapiV1TemplatesTemplateIdRequest': {
    '$ref': '#/components/schemas/TemplateMutationRequest'
  },
  'PutapiV1TemplatesTemplateIdResponse': {
    'additionalProperties': false,
    'properties': {
      'data': {
        '$ref': '#/components/schemas/ScenarioTemplate'
      },
      'meta': {
        '$ref': '#/components/schemas/Meta'
      },
      'ok': {
        'const': true
      }
    },
    'required': [
      'ok',
      'data',
      'meta'
    ],
    'type': 'object'
  },
  'Replay': {
    'additionalProperties': false,
    'properties': {
      'currentTimeS': {
        'minimum': 0,
        'type': 'number'
      },
      'durationS': {
        'minimum': 0,
        'type': 'number'
      },
      'eventIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array'
      },
      'replayId': {
        'pattern': '^REPLAY-',
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'state': {
        'enum': [
          'EMPTY',
          'LOADING',
          'PAUSED',
          'PLAYING',
          'SEEKING',
          'COMPLETED',
          'CORRUPT',
          'ERROR'
        ]
      }
    },
    'required': [
      'replayId',
      'runId',
      'state',
      'durationS',
      'currentTimeS',
      'eventIds'
    ],
    'type': 'object'
  },
  'ReplayCommand': {
    'additionalProperties': false,
    'properties': {
      'command': {
        'enum': [
          'PLAY',
          'PAUSE',
          'SEEK',
          'STEP_FORWARD',
          'STEP_BACK',
          'SPEED'
        ]
      },
      'value': {
        'type': 'number'
      }
    },
    'required': [
      'command'
    ],
    'type': 'object'
  },
  'ReplayList': {
    'items': {
      '$ref': '#/components/schemas/Replay'
    },
    'type': 'array'
  },
  "Report": {
    "additionalProperties": false,
    "allOf": [
      {
        "if": {
          "required": [
            "runId"
          ]
        },
        "then": {
          "required": [
            "timeSeries"
          ]
        }
      },
      {
        "if": {
          "required": [
            "localEvidence"
          ]
        },
        "then": {
          "not": {
            "anyOf": [
              {
                "required": [
                  "runId"
                ]
              },
              {
                "required": [
                  "batchId"
                ]
              },
              {
                "required": [
                  "kpis"
                ]
              },
              {
                "required": [
                  "timeSeries"
                ]
              }
            ]
          },
          "properties": {
            "classification": {
              "const": "LEVEL_II"
            },
            "reportId": {
              "pattern": "^RPT-LOCAL-[a-f0-9]{64}$"
            }
          }
        }
      }
    ],
    "properties": {
      "batchId": {
        "pattern": "^BATCH-",
        "type": "string"
      },
      "classification": {
        "enum": [
          "LEVEL_II",
          "LEVEL_III"
        ]
      },
      "generatedTime": {
        "format": "date-time",
        "type": "string"
      },
      "kpis": {
        "$ref": "#/components/schemas/ReportKpis"
      },
      "localEvidence": {
        "$ref": "#/components/schemas/LocalReportEvidence"
      },
      "reportId": {
        "pattern": "^RPT-",
        "type": "string"
      },
      "runId": {
        "pattern": "^RUN-",
        "type": "string"
      },
      "status": {
        "const": "READY"
      },
      "timeSeries": {
        "items": {
          "$ref": "#/components/schemas/ReportTimeSeries"
        },
        "minItems": 1,
        "type": "array"
      }
    },
    "required": [
      "reportId",
      "classification",
      "generatedTime",
      "status"
    ],
    "type": "object"
  },
  'ReportExportRequest': {
    'additionalProperties': false,
    'properties': {
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'format': {
        'enum': [
          'HTML',
          'PDF',
          'CSV'
        ]
      },
      'reportId': {
        'pattern': '^RPT-',
        'type': 'string'
      }
    },
    'required': [
      'reportId',
      'format'
    ],
    'type': 'object'
  },
  'ReportExportResult': {
    'additionalProperties': false,
    'properties': {
      'generated': {
        'const': false
      },
      'reportId': {
        'pattern': '^RPT-',
        'type': 'string'
      },
      'status': {
        'const': 'FIXTURE_SUCCESS'
      },
      'verifiedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'watermark': {
        'type': 'string'
      }
    },
    'required': [
      'reportId',
      'generated',
      'status',
      'watermark',
      'verifiedAt'
    ],
    'type': 'object'
  },
  'ReportKpis': {
    'additionalProperties': false,
    'properties': {
      'avgBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'avgConnectivityDurationS': {
        'minimum': 0,
        'type': 'number'
      },
      'avgSnrDb': {
        'type': 'number'
      },
      'connectivityRate': {
        'maximum': 100,
        'minimum': 0,
        'type': 'number'
      },
      'interferenceDurationS': {
        'minimum': 0,
        'type': 'number'
      },
      'maxBer': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'minSnrDb': {
        'type': 'number'
      },
      'switchCount': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'connectivityRate',
      'switchCount',
      'avgBer',
      'avgSnrDb',
      'interferenceDurationS',
      'avgConnectivityDurationS',
      'minSnrDb',
      'maxBer'
    ],
    'type': 'object'
  },
  'ReportList': {
    'items': {
      '$ref': '#/components/schemas/Report'
    },
    'type': 'array'
  },
  'ReportTimeSeries': {
    'additionalProperties': false,
    'properties': {
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'points': {
        'items': {
          '$ref': '#/components/schemas/ReportTimeSeriesPoint'
        },
        'minItems': 2,
        'type': 'array'
      },
      'sourcePlatformId': {
        'minLength': 1,
        'type': 'string'
      },
      'targetPlatformId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'linkId',
      'sourcePlatformId',
      'targetPlatformId',
      'points'
    ],
    'type': 'object'
  },
  'ReportTimeSeriesPoint': {
    'additionalProperties': false,
    'properties': {
      'ber': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'interferencePowerDbm': {
        'type': 'number'
      },
      'snrDb': {
        'type': 'number'
      },
      'time': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'time',
      'snrDb',
      'ber',
      'interferencePowerDbm'
    ],
    'type': 'object'
  },
  'ResetFixture': {
    'additionalProperties': false,
    'properties': {
      'method': {
        'const': 'POST'
      },
      'nextSequence': {
        'const': 1
      },
      'path': {
        'const': '/api/v1/reset'
      },
      'requestId': {
        'const': 'REQ-RESET-001'
      },
      'responseGeneratedAt': {
        'format': 'date-time',
        'type': 'string'
      }
    },
    'required': [
      'method',
      'path',
      'requestId',
      'responseGeneratedAt',
      'nextSequence'
    ],
    'type': 'object'
  },
  'ResetRequest': {
    'additionalProperties': false,
    'properties': {
      'confirm': {
        'const': true
      }
    },
    'required': [
      'confirm'
    ],
    'type': 'object'
  },
  'ResetResult': {
    'additionalProperties': false,
    'properties': {
      'generatedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'nextSequence': {
        'const': 1
      },
      'requestId': {
        'const': 'REQ-RESET-001'
      }
    },
    'required': [
      'requestId',
      'generatedAt',
      'nextSequence'
    ],
    'type': 'object'
  },
  'RestoreRequest': {
    'additionalProperties': false,
    'properties': {
      'backupId': {
        'minLength': 1,
        'type': 'string'
      },
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'operation': {
        'const': 'RESTORE'
      }
    },
    'required': [
      'operation',
      'backupId',
      'confirmationId'
    ],
    'type': 'object'
  },
  'RestoreResult': {
    'additionalProperties': false,
    'properties': {
      'generated': {
        'type': 'boolean'
      },
      'integrityValid': {
        'type': 'boolean'
      },
      'prebackupId': {
        'minLength': 1,
        'type': 'string'
      },
      'progress': {
        'maximum': 100,
        'minimum': 0,
        'type': 'number'
      },
      'result': {
        'enum': [
          'SUCCESS',
          'FAILURE'
        ]
      },
      'rolledBack': {
        'type': 'boolean'
      }
    },
    'required': [
      'prebackupId',
      'integrityValid',
      'progress',
      'result',
      'rolledBack',
      'generated'
    ],
    'type': 'object'
  },
  'RouteCandidateEvidence': {
    'additionalProperties': false,
    'properties': {
      'ber': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'direction': {
        'enum': [
          'FORWARD',
          'REVERSE'
        ],
        'type': 'string'
      },
      'eligible': {
        'type': 'boolean'
      },
      'eliminationReason': {
        'oneOf': [
          {
            'minLength': 1,
            'type': 'string'
          },
          {
            'type': 'null'
          }
        ]
      },
      'jamImpactDb': {
        'type': 'number'
      },
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'rank': {
        'minimum': 1,
        'type': 'integer'
      },
      'stabilityFrames': {
        'minimum': 0,
        'type': 'integer'
      }
    },
    'required': [
      'linkId',
      'direction',
      'eligible',
      'jamImpactDb',
      'ber',
      'stabilityFrames',
      'rank',
      'eliminationReason'
    ],
    'type': 'object'
  },
  'RouteDecision': {
    'additionalProperties': false,
    'properties': {
      'direction': {
        'enum': [
          'FORWARD',
          'REVERSE'
        ]
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'hysteresisThreshold': {
        'oneOf': [
          {
            'minimum': 0,
            'type': 'number'
          },
          {
            'type': 'null'
          }
        ]
      },
      'metric': {
        'type': 'number'
      },
      'minimumStableFrames': {
        'minimum': 1,
        'type': 'integer'
      },
      'previousLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'reason': {
        'minLength': 1,
        'type': 'string'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'selectedLinkId': {
        'minLength': 1,
        'type': 'string'
      },
      'simulationTime': {
        'minimum': 0,
        'type': 'number'
      },
      'strategy': {
        'enum': [
          'MIN_JAM_IMPACT',
          'MIN_BER_WITH_HYSTERESIS'
        ]
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'taskId',
      'runId',
      'frameId',
      'simulationTime',
      'direction',
      'selectedLinkId',
      'previousLinkId',
      'strategy',
      'metric',
      'minimumStableFrames',
      'hysteresisThreshold',
      'reason'
    ],
    'type': 'object'
  },
  'RouteMetadata': {
    'additionalProperties': false,
    'properties': {
      'guard': {
        'type': 'string'
      },
      'page': {
        'type': 'string'
      },
      'path': {
        'pattern': '^/',
        'type': 'string'
      },
      'stores': {
        'items': {
          'type': 'string'
        },
        'type': 'array'
      }
    },
    'required': [
      'path',
      'page',
      'stores',
      'guard'
    ],
    'type': 'object'
  },
  'RouteMetadataList': {
    'items': {
      '$ref': '#/components/schemas/RouteMetadata'
    },
    'maxItems': 11,
    'minItems': 11,
    'type': 'array'
  },
  'ScenarioConfig': {
    'additionalProperties': false,
    'properties': {
      'informationDemand': {
        'items': {
          '$ref': '#/components/schemas/InformationDemand'
        },
        'minItems': 1,
        'type': 'array'
      },
      'jammers': {
        'items': {
          '$ref': '#/components/schemas/Jammer'
        },
        'type': 'array'
      },
      'jammingEnabled': {
        'type': 'boolean'
      },
      'linkSettings': {
        '$ref': '#/components/schemas/ScenarioLinkSettings'
      },
      'links': {
        'items': {
          '$ref': '#/components/schemas/Link'
        },
        'type': 'array'
      },
      'output': {
        '$ref': '#/components/schemas/OutputConfig'
      },
      'platforms': {
        'items': {
          '$ref': '#/components/schemas/Platform'
        },
        'minItems': 1,
        'type': 'array',
        'x-business-information-node-limits': {
          'AIRBORNE_MISSION_CLUSTER': 47,
          'FORWARD_RELAY_NODE': 1,
          'GROUND_CLUSTER_COMMAND_NODE': 1,
          'REAR_COMMAND_NODE': 1
        },
        'x-business-information-node-types': [
          'REAR_COMMAND_NODE',
          'FORWARD_RELAY_NODE',
          'GROUND_CLUSTER_COMMAND_NODE',
          'AIRBORNE_MISSION_CLUSTER'
        ],
        'x-max-business-information-nodes': 50,
        'x-min-business-information-nodes': 1,
        'x-supporting-entity-types-excluded-from-capacity': [
          'COMMUNICATION_SATELLITE',
          'GROUND_JAMMER_DETECTION_STATION',
          'AIRBORNE_JAMMER_PLATFORM'
        ]
      },
      'scenario': {
        '$ref': '#/components/schemas/ScenarioIdentity'
      },
      'schemaVersion': {
        'const': '1.0'
      },
      'sensors': {
        'items': {
          '$ref': '#/components/schemas/Sensor'
        },
        'type': 'array'
      }
    },
    'required': [
      'schemaVersion',
      'scenario',
      'platforms',
      'links',
      'jammers',
      'sensors',
      'output',
      'informationDemand'
    ],
    'type': 'object',
    'x-fixture-path': '$.scenario',
    'x-source': 'SRS §1.2.2 and §3.5.3 Table 22; approved frontend baseline V1.1 §6.1'
  },
  'ScenarioConfigWrite': {
    'allOf': [
      {
        '$ref': '#/components/schemas/ScenarioConfig'
      },
      {
        'properties': {
          'platforms': {
            'items': {
              '$ref': '#/components/schemas/PlatformWrite'
            },
            'type': 'array'
          }
        }
      }
    ],
    'description': '写入时每台干扰设备的 platformId 必须指向当前 platforms 中的地面干扰站或机载干扰平台；跨集合归属由共享运行时校验拒绝，ScenarioConfig 读取仍兼容旧归属。'
  },
  'ScenarioCoverageFixture': {
    'additionalProperties': false,
    'properties': {
      'acceptedBusinessNodeCount': {
        'const': 50
      },
      'businessNodeTypes': {
        'items': {
          'enum': [
            'REAR_COMMAND_NODE',
            'FORWARD_RELAY_NODE',
            'GROUND_CLUSTER_COMMAND_NODE',
            'AIRBORNE_MISSION_CLUSTER'
          ]
        },
        'maxItems': 4,
        'minItems': 4,
        'type': 'array',
        'uniqueItems': true
      },
      'jammerTypes': {
        'items': {
          'enum': [
            'BARRAGE',
            'SPOT',
            'SWEEP'
          ]
        },
        'maxItems': 2,
        'minItems': 2,
        'type': 'array',
        'uniqueItems': true
      },
      'linkTypes': {
        'items': {
          'enum': [
            'SAT',
            'MICROWAVE',
            'DATALINK',
            'LASER'
          ]
        },
        'maxItems': 4,
        'minItems': 4,
        'type': 'array',
        'uniqueItems': true
      },
      'minimumInformationDemandCount': {
        'const': 1
      },
      'rejectedBusinessNodeCount': {
        'const': 51
      },
      'rejection': {
        'additionalProperties': false,
        'properties': {
          'code': {
            'const': 'NODE_LIMIT_EXCEEDED'
          },
          'fieldPath': {
            'const': 'platforms'
          },
          'mutationApplied': {
            'const': false
          }
        },
        'required': [
          'code',
          'fieldPath',
          'mutationApplied'
        ],
        'type': 'object'
      },
      'supportingEntityTypes': {
        'items': {
          'enum': [
            'COMMUNICATION_SATELLITE',
            'GROUND_JAMMER_DETECTION_STATION',
            'AIRBORNE_JAMMER_PLATFORM'
          ]
        },
        'maxItems': 2,
        'minItems': 2,
        'type': 'array',
        'uniqueItems': true
      }
    },
    'required': [
      'businessNodeTypes',
      'supportingEntityTypes',
      'acceptedBusinessNodeCount',
      'rejectedBusinessNodeCount',
      'rejection',
      'linkTypes',
      'jammerTypes',
      'minimumInformationDemandCount'
    ],
    'type': 'object'
  },
  'ScenarioDraft': {
    'additionalProperties': false,
    'properties': {
      'config': {
        '$ref': '#/components/schemas/ScenarioConfig'
      },
      'locked': {
        'type': 'boolean'
      },
      'officialLibraryChanged': {
        'const': false
      },
      'revision': {
        'minimum': 0,
        'type': 'integer'
      },
      'uiExtensions': {
        '$ref': '#/components/schemas/ScenarioUiExtensions'
      }
    },
    'required': [
      'config',
      'uiExtensions',
      'revision',
      'officialLibraryChanged',
      'locked'
    ],
    'type': 'object'
  },
  'ScenarioDraftUpdate': {
    'additionalProperties': false,
    'properties': {
      'config': {
        '$ref': '#/components/schemas/ScenarioConfigWrite'
      },
      'expectedRevision': {
        'minimum': 0,
        'type': 'integer'
      },
      'uiExtensions': {
        '$ref': '#/components/schemas/ScenarioUiExtensions'
      }
    },
    'required': [
      'config',
      'uiExtensions'
    ],
    'type': 'object'
  },
  'ScenarioIdentity': {
    'additionalProperties': false,
    'properties': {
      'description': {
        'maxLength': 512,
        'type': 'string'
      },
      'duration': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'environment': {
        '$ref': '#/components/schemas/Environment'
      },
      'id': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'name': {
        'maxLength': 128,
        'minLength': 1,
        'type': 'string'
      },
      'startTime': {
        'format': 'date-time',
        'type': 'string'
      },
      'timeStep': {
        'exclusiveMinimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'id',
      'name',
      'description',
      'startTime',
      'duration',
      'timeStep',
      'environment'
    ],
    'type': 'object'
  },
  'ScenarioImportRequest': {
    'additionalProperties': false,
    'properties': {
      'items': {
        'items': {
          '$ref': '#/components/schemas/ScenarioConfigWrite'
        },
        'maxItems': 1,
        'minItems': 1,
        'type': 'array'
      }
    },
    'required': [
      'items'
    ],
    'type': 'object'
  },
  'ScenarioLinkSettings': {
    'additionalProperties': false,
    'properties': {
      'enabledSatellites': {
        'additionalProperties': false,
        'properties': {
          'SHENTONG': {
            'type': 'boolean'
          },
          'TIANTONG': {
            'type': 'boolean'
          }
        },
        'required': [
          'TIANTONG',
          'SHENTONG'
        ],
        'type': 'object'
      },
      'enabledTypes': {
        'additionalProperties': false,
        'deprecated': true,
        'description': '仅兼容历史配置；单条链路的 enabled 优先，新配置不再生成此字段。',
        'properties': {
          'DATALINK': {
            'type': 'boolean'
          },
          'LASER': {
            'type': 'boolean'
          },
          'MICROWAVE': {
            'type': 'boolean'
          },
          'SAT': {
            'type': 'boolean'
          }
        },
        'required': [
          'SAT',
          'MICROWAVE',
          'DATALINK',
          'LASER'
        ],
        'type': 'object'
      },
      'priority': {
        'items': {
          'enum': [
            'SAT',
            'MICROWAVE',
            'DATALINK',
            'LASER'
          ],
          'type': 'string'
        },
        'maxItems': 4,
        'minItems': 4,
        'type': 'array',
        'uniqueItems': true
      },
      'switchCooldownS': {
        'default': 5,
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'enabledSatellites',
      'switchCooldownS',
      'priority'
    ],
    'type': 'object'
  },
  'ScenarioList': {
    'items': {
      '$ref': '#/components/schemas/ScenarioDraft'
    },
    'type': 'array'
  },
  'ScenarioTemplate': {
    'additionalProperties': false,
    'properties': {
      'config': {
        '$ref': '#/components/schemas/ScenarioConfig'
      },
      'name': {
        'type': 'string'
      },
      'official': {
        'type': 'boolean'
      },
      'referenceCount': {
        'minimum': 0,
        'type': 'integer'
      },
      'templateId': {
        'minLength': 1,
        'type': 'string'
      },
      'uiExtensions': {
        '$ref': '#/components/schemas/ScenarioUiExtensions'
      },
      'version': {
        'type': 'string'
      }
    },
    'required': [
      'templateId',
      'name',
      'version',
      'official',
      'config',
      'referenceCount'
    ],
    'type': 'object'
  },
  'ScenarioTemplateIndex': {
    'additionalProperties': false,
    'properties': {
      'name': {
        'type': 'string'
      },
      'official': {
        'type': 'boolean'
      },
      'referenceCount': {
        'minimum': 0,
        'type': 'integer'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'templateId': {
        'minLength': 1,
        'type': 'string'
      },
      'version': {
        'type': 'string'
      }
    },
    'required': [
      'templateId',
      'scenarioId',
      'name',
      'version',
      'official',
      'referenceCount'
    ],
    'type': 'object'
  },
  'ScenarioUiExtensions': {
    'additionalProperties': false,
    'properties': {
      'jammers': {
        'items': {
          '$ref': '#/components/schemas/JammerUiExtension'
        },
        'type': 'array'
      },
      'sensors': {
        'items': {
          '$ref': '#/components/schemas/SensorUiExtension'
        },
        'type': 'array'
      }
    },
    'required': [
      'jammers',
      'sensors'
    ],
    'type': 'object'
  },
  'ScenarioValidationRequest': {
    'additionalProperties': false,
    'properties': {
      'config': {
        '$ref': '#/components/schemas/ScenarioConfig'
      }
    },
    'required': [
      'config'
    ],
    'type': 'object'
  },
  'ScriptContract': {
    'additionalProperties': false,
    'properties': {
      'checksum': {
        'type': 'string'
      },
      'configVersion': {
        'type': 'string'
      },
      'generatedTime': {
        'format': 'date-time',
        'type': 'string'
      },
      'preview': {
        'type': 'string'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'scriptId': {
        'minLength': 1,
        'type': 'string'
      },
      'target': {
        'const': 'AFSIM 2.9.0'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'scriptId',
      'taskId',
      'scenarioId',
      'configVersion',
      'target',
      'checksum',
      'preview',
      'generatedTime'
    ],
    'type': 'object'
  },
  'ScriptPreviewRequest': {
    'additionalProperties': false,
    'description': 'warningConfirmationId is required by business validation when the latest result contains WARNING and no ERROR. ERROR always blocks preview.',
    'properties': {
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'warningConfirmationId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'scenarioId'
    ],
    'type': 'object'
  },
  'Sensor': {
    'additionalProperties': false,
    'properties': {
      'detectionRange': {
        'minimum': 0,
        'type': 'number'
      },
      'frequencyRange': {
        '$ref': '#/components/schemas/FrequencyRange'
      },
      'id': {
        'minLength': 1,
        'type': 'string'
      },
      'platformId': {
        'minLength': 1,
        'type': 'string'
      }
    },
    'required': [
      'id',
      'platformId',
      'frequencyRange',
      'detectionRange'
    ],
    'type': 'object'
  },
  'SensorUiExtension': {
    'additionalProperties': false,
    'properties': {
      'direction': {
        'oneOf': [
          {
            'const': 'OMNI'
          },
          {
            'maximum': 360,
            'minimum': 0,
            'type': 'number'
          }
        ]
      },
      'enabled': {
        'type': 'boolean'
      },
      'probability': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'sensorId': {
        'minLength': 1,
        'type': 'string'
      },
      'type': {
        'const': 'ESM'
      }
    },
    'required': [
      'sensorId',
      'type',
      'direction',
      'probability',
      'enabled'
    ],
    'type': 'object'
  },
  'SimulationCommand': {
    'additionalProperties': false,
    'description': 'START requires mode; SET_SPEED requires speedMultiplier; STEP requires stepCount=1; STOP requires a valid SIMULATION_STOP confirmation when unsaved execution state would be discarded.',
    'properties': {
      'command': {
        'enum': [
          'START',
          'PAUSE',
          'RESUME',
          'STEP',
          'STOP',
          'SET_SPEED'
        ]
      },
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'mode': {
        'enum': [
          'INTERACTIVE_SINGLE',
          'BATCH_PARAMETER_TRAVERSAL',
          'PARAMETER_SCAN',
          'HISTORICAL_REPLAY'
        ]
      },
      'speedMultiplier': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'stepCount': {
        'const': 1
      }
    },
    'required': [
      'command'
    ],
    'type': 'object'
  },
  'SimulationCreateRequest': {
    'additionalProperties': false,
    'properties': {
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'taskId',
      'scenarioId'
    ],
    'type': 'object'
  },
  'SimulationRun': {
    'additionalProperties': false,
    'properties': {
      'canonical': {
        '$ref': '#/components/schemas/SimulationState'
      },
      'completedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'configLocked': {
        'type': 'boolean'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'startedAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      },
      'uiStatus': {
        'enum': [
          'IDLE',
          'RUNNING',
          'PAUSED',
          'STOPPED',
          'COMPLETED',
          'ERROR'
        ]
      }
    },
    'required': [
      'runId',
      'taskId',
      'scenarioId',
      'uiStatus',
      'canonical',
      'configLocked'
    ],
    'type': 'object',
    'x-fixture-path': '$.run'
  },
  'SimulationRunList': {
    'items': {
      '$ref': '#/components/schemas/SimulationRun'
    },
    'type': 'array'
  },
  'SimulationState': {
    'additionalProperties': false,
    'properties': {
      'currentTime': {
        'minimum': 0,
        'type': 'number'
      },
      'errorMessage': {
        'type': 'string'
      },
      'processId': {
        'minimum': 1,
        'type': [
          'integer',
          'null'
        ]
      },
      'progress': {
        'maximum': 100,
        'minimum': 0,
        'type': 'number'
      },
      'status': {
        'enum': [
          'IDLE',
          'RUNNING',
          'PAUSED',
          'COMPLETED',
          'ERROR'
        ]
      },
      'totalDuration': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'status',
      'currentTime',
      'totalDuration',
      'processId',
      'progress'
    ],
    'type': 'object'
  },
  'SyncResult': {
    'additionalProperties': false,
    'properties': {
      'configParameterVersion': {
        'minimum': 1,
        'type': 'integer'
      },
      'effectiveFrameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'effectiveSimulationTime': {
        'minimum': 0,
        'type': 'number'
      },
      'engineParameterVersion': {
        'minimum': 1,
        'type': 'integer'
      },
      'jammerId': {
        'minLength': 1,
        'type': 'string'
      },
      'jammerStatus': {
        '$ref': '#/components/schemas/JammerStatusData'
      },
      'nodeParameterVersion': {
        'minimum': 1,
        'type': 'integer'
      },
      'parameterVersion': {
        'minimum': 1,
        'type': 'integer'
      },
      'status': {
        'const': 'SYNCHRONIZED'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      },
      'uiParameterVersion': {
        'minimum': 1,
        'type': 'integer'
      }
    },
    'required': [
      'taskId',
      'jammerId',
      'parameterVersion',
      'configParameterVersion',
      'nodeParameterVersion',
      'engineParameterVersion',
      'uiParameterVersion',
      'effectiveFrameId',
      'effectiveSimulationTime',
      'status',
      'jammerStatus'
    ],
    'type': 'object'
  },
  'SynchronizationEvidence': {
    'additionalProperties': false,
    'properties': {
      'configVersion': {
        'const': 'SCN-001-v4'
      },
      'effectiveFrameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'effectiveSimulationTime': {
        'minimum': 0,
        'type': 'number'
      },
      'engineVersion': {
        'const': 'AFSIM-2.9.0-FIXTURE'
      },
      'uiVersion': {
        'const': 'FRAME-1.0'
      }
    },
    'required': [
      'configVersion',
      'engineVersion',
      'uiVersion',
      'effectiveFrameId',
      'effectiveSimulationTime'
    ],
    'type': 'object'
  },
  'SystemHealth': {
    'additionalProperties': false,
    'properties': {
      'channel': {
        'const': 'NOT_CONNECTED_BY_DESIGN'
      },
      'database': {
        'const': 'NOT_CONNECTED_BY_DESIGN'
      },
      'engine': {
        'const': 'NOT_CONNECTED_BY_DESIGN'
      },
      'ui': {
        'const': 'HEALTHY'
      }
    },
    'required': [
      'ui',
      'engine',
      'database',
      'channel'
    ],
    'type': 'object'
  },
  'TaskFixture': {
    'additionalProperties': false,
    'properties': {
      'configVersion': {
        'type': 'string'
      },
      'createdAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'scenarioId': {
        'pattern': '^SCN-',
        'type': 'string'
      },
      'scriptId': {
        'minLength': 1,
        'type': 'string'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      }
    },
    'required': [
      'taskId',
      'scenarioId',
      'configVersion',
      'scriptId',
      'createdAt'
    ],
    'type': 'object'
  },
  'TelemetryFrame': {
    'additionalProperties': false,
    'properties': {
      'eventIds': {
        'items': {
          'minLength': 1,
          'type': 'string'
        },
        'type': 'array',
        'uniqueItems': true
      },
      'evidence': {
        '$ref': '#/components/schemas/FrameEvidence'
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'linkSummaries': {
        'items': {
          '$ref': '#/components/schemas/LinkStatusSummary'
        },
        'type': 'array'
      },
      'links': {
        'items': {
          '$ref': '#/components/schemas/TelemetryLinkRecord'
        },
        'type': 'array'
      },
      'platforms': {
        'items': {
          '$ref': '#/components/schemas/PlatformStatus'
        },
        'type': 'array'
      },
      'runId': {
        'pattern': '^RUN-',
        'type': 'string'
      },
      'sequence': {
        'minimum': 1,
        'type': 'integer'
      },
      'simulationTime': {
        'minimum': 0,
        'type': 'number'
      },
      'taskId': {
        'pattern': '^TASK-',
        'type': 'string'
      },
      'uiLinks': {
        'items': {
          '$ref': '#/components/schemas/UiLinkProjection'
        },
        'type': 'array'
      }
    },
    'required': [
      'frameId',
      'taskId',
      'runId',
      'simulationTime',
      'sequence',
      'platforms',
      'links',
      'linkSummaries',
      'uiLinks',
      'eventIds',
      'evidence'
    ],
    'type': 'object',
    'x-fixture-path': '$.frame'
  },
  'TelemetryLinkRecord': {
    'additionalProperties': false,
    'properties': {
      'bandwidth': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'ber': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'berThreshold': {
        'maximum': 1,
        'minimum': 0,
        'type': 'number'
      },
      'coding': {
        'const': 'UNCODED'
      },
      'dataRate': {
        'minimum': 0,
        'type': 'number'
      },
      'destPlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'distance': {
        'minimum': 0,
        'type': 'number'
      },
      'frequency': {
        'exclusiveMinimum': 0,
        'type': 'number'
      },
      'jammingPower': {
        'type': 'number'
      },
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'linkStatus': {
        'enum': [
          'UP',
          'DOWN'
        ]
      },
      'linkType': {
        'enum': [
          'SAT',
          'MICROWAVE',
          'DATALINK',
          'LASER'
        ],
        'type': 'string'
      },
      'modulation': {
        'enum': [
          'BPSK',
          'QPSK'
        ],
        'type': 'string'
      },
      'pathLoss': {
        'type': 'number'
      },
      'qualityModelVersion': {
        'const': 'SNBER-1.2'
      },
      'receivedPower': {
        'type': 'number'
      },
      'rxAntennaGain': {
        'type': 'number'
      },
      'snr': {
        'type': 'number'
      },
      'sourcePlatform': {
        'minLength': 1,
        'type': 'string'
      },
      'time': {
        'minimum': 0,
        'type': 'number'
      },
      'txAntennaGain': {
        'type': 'number'
      },
      'txPower': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'linkId',
      'time',
      'sourcePlatform',
      'destPlatform',
      'linkType',
      'frequency',
      'bandwidth',
      'distance',
      'txPower',
      'txAntennaGain',
      'rxAntennaGain',
      'pathLoss',
      'jammingPower',
      'receivedPower',
      'snr',
      'modulation',
      'coding',
      'qualityModelVersion',
      'ber',
      'linkStatus',
      'berThreshold',
      'dataRate'
    ],
    'type': 'object'
  },
  'TemplateList': {
    'items': {
      '$ref': '#/components/schemas/ScenarioTemplate'
    },
    'type': 'array'
  },
  'TemplateMutationRequest': {
    'additionalProperties': false,
    'properties': {
      'config': {
        '$ref': '#/components/schemas/ScenarioConfigWrite'
      },
      'name': {
        'minLength': 1,
        'type': 'string'
      },
      'uiExtensions': {
        '$ref': '#/components/schemas/ScenarioUiExtensions'
      }
    },
    'required': [
      'name',
      'config'
    ],
    'type': 'object'
  },
  'UiLinkProjection': {
    'additionalProperties': false,
    'properties': {
      'ageMs': {
        'maximum': 5000,
        'minimum': 0,
        'type': 'number'
      },
      'canonicalStatus': {
        'enum': [
          'UP',
          'DOWN'
        ]
      },
      'consecutiveFrames': {
        'minimum': 0,
        'type': 'integer'
      },
      'frameId': {
        'pattern': '^F-',
        'type': 'string'
      },
      'linkId': {
        'minLength': 1,
        'type': 'string'
      },
      'reason': {
        'minLength': 1,
        'type': 'string'
      },
      'status': {
        'enum': [
          'UP',
          'DEGRADED',
          'DOWN'
        ]
      },
      'thresholdVersion': {
        'const': 'LLZT-1.0'
      }
    },
    'required': [
      'linkId',
      'frameId',
      'status',
      'canonicalStatus',
      'reason',
      'thresholdVersion',
      'consecutiveFrames',
      'ageMs'
    ],
    'type': 'object'
  },
  'User': {
    'additionalProperties': false,
    'properties': {
      'lastLoginAt': {
        'format': 'date-time',
        'type': 'string'
      },
      'role': {
        'enum': [
          'ADMIN',
          'OPERATOR'
        ],
        'type': 'string'
      },
      'status': {
        'enum': [
          'ACTIVE',
          'DISABLED',
          'LOCKED'
        ]
      },
      'userId': {
        'minLength': 1,
        'type': 'string'
      },
      'username': {
        'type': 'string'
      }
    },
    'required': [
      'userId',
      'username',
      'role',
      'status'
    ],
    'type': 'object'
  },
  'UserList': {
    'items': {
      '$ref': '#/components/schemas/User'
    },
    'type': 'array'
  },
  'UserRoleCommand': {
    'additionalProperties': false,
    'allOf': [
      {
        'if': {
          'required': [
            'password'
          ]
        },
        'then': {
          'properties': {
            'operation': {
              'const': 'CREATE'
            }
          }
        }
      }
    ],
    'properties': {
      'confirmationId': {
        'minLength': 1,
        'type': 'string'
      },
      'operation': {
        'enum': [
          'CREATE',
          'UPDATE',
          'DELETE',
          'ENABLE',
          'DISABLE'
        ]
      },
      'password': {
        'description': 'Required when creating a SQLite account; never returned in User.',
        'maxLength': 32,
        'minLength': 6,
        'type': 'string',
        'writeOnly': true
      },
      'user': {
        '$ref': '#/components/schemas/User'
      }
    },
    'required': [
      'operation',
      'user'
    ],
    'type': 'object'
  },
  'ValidationIssue': {
    'additionalProperties': false,
    'properties': {
      'code': {
        'type': 'string'
      },
      'fieldPath': {
        'type': 'string'
      },
      'message': {
        'type': 'string'
      },
      'severity': {
        'enum': [
          'ERROR',
          'WARNING'
        ]
      }
    },
    'required': [
      'severity',
      'code',
      'message',
      'fieldPath'
    ],
    'type': 'object'
  },
  'ValidationResult': {
    'additionalProperties': false,
    'properties': {
      'errors': {
        'items': {
          '$ref': '#/components/schemas/ValidationIssue'
        },
        'type': 'array'
      },
      'valid': {
        'type': 'boolean'
      },
      'warnings': {
        'items': {
          '$ref': '#/components/schemas/ValidationIssue'
        },
        'type': 'array'
      }
    },
    'required': [
      'valid',
      'errors',
      'warnings'
    ],
    'type': 'object'
  },
  'Waypoint': {
    'additionalProperties': false,
    'properties': {
      'altitude': {
        'minimum': 0,
        'type': 'number'
      },
      'arrivalTime': {
        'minimum': 0,
        'type': 'number'
      },
      'latitude': {
        'maximum': 90,
        'minimum': -90,
        'type': 'number'
      },
      'longitude': {
        'maximum': 180,
        'minimum': -180,
        'type': 'number'
      },
      'speed': {
        'minimum': 0,
        'type': 'number'
      }
    },
    'required': [
      'longitude',
      'latitude',
      'altitude',
      'speed',
      'arrivalTime'
    ],
    'type': 'object'
  }
}
)
