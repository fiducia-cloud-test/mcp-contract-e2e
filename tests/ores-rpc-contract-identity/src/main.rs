use ores_api_docs::{RouteMap, contract_sha256};

fn main() {
    formatting_and_key_order_do_not_change_identity();
    semantic_wire_change_changes_identity();
    duplicate_http_binding_fails_closed();
    println!("fiducia-cloud-test ores RPC contract identity certification passed");
}

fn formatting_and_key_order_do_not_change_identity() {
    let left = RouteMap::from_json_str(
        r#"{
          "schema_version": "1.0.0",
          "service": "ores-stack-rpc-cert",
          "title": "ORES Stack RPC Certification",
          "version": "1.0.0",
          "description": "semantic identity",
          "map": {
            "healthz": "/healthz",
            "get_item": {
              "path": "/v1/items/{id}",
              "methods": ["GET"],
              "transports": ["http"],
              "path_params": {
                "type": "object",
                "required": ["id"],
                "properties": {
                  "id": { "type": "string", "minLength": 1 }
                }
              }
            }
          }
        }"#,
    )
    .expect("left route map must parse");

    let right = RouteMap::from_json_str(
        r#"{"map":{"get_item":{"transports":["http"],"methods":["GET"],"path_params":{"properties":{"id":{"minLength":1,"type":"string"}},"required":["id"],"type":"object"},"path":"/v1/items/{id}"},"healthz":"/healthz"},"description":"semantic identity","version":"1.0.0","title":"ORES Stack RPC Certification","service":"ores-stack-rpc-cert","schema_version":"1.0.0"}"#,
    )
    .expect("right route map must parse");

    assert_eq!(
        contract_sha256(&left),
        contract_sha256(&right),
        "JSON formatting and object-key order must not change normalized RPC identity"
    );
}

fn semantic_wire_change_changes_identity() {
    let before = RouteMap::from_json_str(
        r#"{
          "schema_version": "1.0.0",
          "service": "ores-stack-rpc-cert",
          "title": "ORES Stack RPC Certification",
          "version": "1.0.0",
          "description": "semantic identity",
          "map": { "healthz": "/healthz" }
        }"#,
    )
    .expect("before map");
    let after = RouteMap::from_json_str(
        r#"{
          "schema_version": "1.0.0",
          "service": "ores-stack-rpc-cert",
          "title": "ORES Stack RPC Certification",
          "version": "1.0.0",
          "description": "semantic identity",
          "map": { "healthz": "/healthz-v2" }
        }"#,
    )
    .expect("after map");
    assert_ne!(
        contract_sha256(&before),
        contract_sha256(&after),
        "a wire-path change must change normalized RPC identity"
    );
}

fn duplicate_http_binding_fails_closed() {
    let error = RouteMap::from_json_str(
        r#"{
          "schema_version": "1.0.0",
          "service": "ores-stack-rpc-cert",
          "map": {
            "first": { "path": "/dup", "methods": ["GET"], "transports": ["http"] },
            "second": { "path": "/dup", "methods": ["GET"], "transports": ["http"] }
          }
        }"#,
    )
    .expect_err("duplicate HTTP method/path binding must fail closed");
    let message = error.to_string();
    assert!(
        message.contains("both bind GET /dup"),
        "unexpected error: {message}"
    );
}
