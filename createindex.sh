#!/usr/bin/env bash
curl -XPUT "localhost:9200/cars-v18?pretty" -H 'Content-Type: application/json' -d "@mappings/cars.json"
curl -X POST "localhost:9200/_aliases" -H 'Content-Type: application/json' -d'
{
    "actions" : [
        { "remove" : { "index" : "cars-v17", "alias" : "cars" } },
        { "add" : { "index" : "cars-v18", "alias" : "cars" } }
    ]
}
'

