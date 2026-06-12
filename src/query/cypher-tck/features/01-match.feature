@tck @match
Feature: MATCH — Pattern Matching

  Scenario Outline: MATCH query execution
    Given a graph with the following nodes:
      | _label  | name     | age | city |
      | Person  | Alice    | 30  | NYC  |
      | Person  | Bob      | 25  | LA   |
      | Person  | Charlie  | 35  | NYC  |
      | Person  | Diana    | 28  | SF   |
      | Person  | Eve      | 32  | NYC  |
      | Person  | Frank    | 40  | LA   |
      | Company | Acme     |     |      |
    When executing query:
      """
      <query>
      """
    Then the result should have <expectedCount> rows

    Examples:
      | query                                        | expectedCount |
      | MATCH (n:Person) RETURN n                    | 6             |
      | MATCH (n:Person) WHERE n.age > 30 RETURN n   | 3             |
      | MATCH (n:Person) WHERE n.city = "NYC" RETURN n | 3           |
      | MATCH (n) RETURN n                           | 7             |
      | MATCH (n:Person) RETURN n.name               | 6             |
