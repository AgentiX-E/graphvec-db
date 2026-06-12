@tck @dml
Feature: DML — CREATE / DELETE / SET / MERGE

  Scenario: CREATE node
    Given an empty graph
    When executing query:
      """
      CREATE (n:Person {name: "Alice", age: 30}) RETURN n
      """
    Then the query should succeed

  Scenario: DELETE node
    Given a graph with the following nodes:
      | _label  | name     |
      | Person  | Alice    |
      | Person  | Bob      |
    When executing query:
      """
      MATCH (n:Person {name: "Bob"}) DELETE n
      """
    Then the query should succeed

  Scenario: SET property
    Given a graph with the following nodes:
      | _label  | name     | age |
      | Person  | Alice    | 30  |
    When executing query:
      """
      MATCH (n:Person {name: "Alice"}) SET n.age = 35 RETURN n.age
      """
    Then the result should have 1 row
